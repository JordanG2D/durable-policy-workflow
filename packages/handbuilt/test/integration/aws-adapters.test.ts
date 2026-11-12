import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { claimEvent, publishDue } from "../../src/aws/queue.js";
import { createDemoProviders } from "../../src/aws/demoProviders.js";
import { mirrorDeadLetter } from "../../src/aws/deadLetter.js";
import { withTransaction, type Pool } from "../../src/db/pool.js";
import { completeWithFence, scheduleRetry } from "../../src/outbox/outbox.js";
import { createTestWorkflow, resetDb, setupDb } from "../helpers/db.js";
let pool: Pool;
beforeAll(async () => { pool = await setupDb(); });
beforeEach(async () => { await resetDb(pool); });
afterAll(async () => { await pool?.end(); });
async function fresh() {
  const workflowId = await createTestWorkflow(pool);
  const { rows } = await pool.query<{ event_id: string }>("SELECT event_id FROM outbox WHERE workflow_id=$1", [workflowId]);
  return rows[0]!.event_id;
}
it("one of concurrent queue deliveries obtains a fenced claim; reclaim invalidates the old worker", async () => {
  const id = await fresh();
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimEvent(pool, id, 15000)));
  const first = claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  await pool.query("UPDATE outbox SET lease_expires_at=now()-interval '1 second' WHERE event_id=$1", [id]);
  const second = (await claimEvent(pool, id, 15000))!;
  expect(second.attempts).toBe(2);
  await expect(withTransaction(pool, (tx) => completeWithFence(tx, first))).rejects.toThrow("lease lost");
  await withTransaction(pool, (tx) => completeWithFence(tx, second));
  expect(await claimEvent(pool, id, 15000)).toBeUndefined();
});
it("DB backoff prevents queue replay and publisher from consuming another attempt", async () => {
  const id = await fresh();
  const claim = (await claimEvent(pool, id, 15000))!;
  await withTransaction(pool, (tx) => scheduleRetry(tx, claim, 60000, "synthetic failure"));
  expect(await claimEvent(pool, id, 15000)).toBeUndefined();
  const send = vi.fn();
  expect(await publishDue(pool, { send }, "queue")).toBe(0);
  expect(send).not.toHaveBeenCalled();
  const result = await pool.query<{ attempts: number }>("SELECT attempts FROM outbox WHERE event_id=$1", [id]);
  expect(result.rows[0]!.attempts).toBe(1);
});
it("synthetic provider effects survive process recreation and concurrent replay", async () => {
  const req = { idempotencyKey: randomUUID(), reference: randomUUID(), amountCents: 1234, callbackUrl: "https://synthetic.invalid" };
  const calls = await Promise.all(Array.from({ length: 8 }, () => createDemoProviders(pool).payments.charge(req)));
  expect(new Set(calls.map((r) => r.chargeId)).size).toBe(1);
  await expect(createDemoProviders(pool).payments.charge({ ...req, amountCents: 999 })).rejects.toThrow("parameter mismatch");
  const document = { idempotencyKey: randomUUID(), policyNumber: "SYNTHETIC", recipient: "test@example.invalid" };
  expect(await createDemoProviders(pool).documents.deliver(document)).toEqual(await createDemoProviders(pool).documents.deliver(document));
});
it("DLQ send failure retains pending notice; crash after send duplicates stable identity safely", async () => {
  const id = await fresh();
  await pool.query("UPDATE outbox SET type='workflow.dead_lettered' WHERE event_id=$1", [id]);
  const first = (await claimEvent(pool, id, 15000))!;
  await expect(mirrorDeadLetter(pool, { send: async () => { throw new Error("SQS unavailable"); } }, "dlq", first)).rejects.toThrow();
  expect((await pool.query<{ status: string }>("SELECT status FROM outbox WHERE event_id=$1", [id])).rows[0]!.status).toBe("pending");
  await pool.query("UPDATE outbox SET lease_expires_at=now()-interval '1 second' WHERE event_id=$1", [id]);
  const second = (await claimEvent(pool, id, 15000))!;
  const send = vi.fn().mockResolvedValue(undefined);
  await expect(mirrorDeadLetter(pool, { send }, "dlq", first)).rejects.toThrow("lease lost");
  await mirrorDeadLetter(pool, { send }, "dlq", second);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]![1]).toBe(send.mock.calls[1]![1]);
  expect((await pool.query<{ status: string }>("SELECT status FROM outbox WHERE event_id=$1", [id])).rows[0]!.status).toBe("done");
});

it("runs a complete policy through publisher and SQS worker with duplicate deliveries", async () => {
  const { Relay } = await import("../../src/outbox/relay.js");
  const { createStepHandlers, createDeadLetterHandler } = await import("../../src/workflow/steps.js");
  const { createMetrics } = await import("../../src/observability/metrics.js");
  const { createLogger } = await import("@policy/domain/logger");
  const { rulePricing } = await import("@policy/domain/pricing");
  const { createQueueWorker } = await import("../../src/aws/queue.js");
  const log = createLogger("silent");
  const metrics = createMetrics({ defaultMetrics: false });
  const providers = createDemoProviders(pool);
  const relay = new Relay({ pool, logger: log, metrics,
    handlers: createStepHandlers({ pool, log, metrics, pricing: rulePricing, ...providers, paymentCallbackUrl: "https://synthetic.invalid" }),
    onDeadLetter: createDeadLetterHandler({ log, metrics }),
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    leaseMs: 15000, batchSize: 10, pollIntervalMs: 1,
  });
  const workflowId = await createTestWorkflow(pool);
  const run = createQueueWorker({ claim: (id) => claimEvent(pool, id, 15000), relay });
  for (let step = 0; step < 8; step++) {
    const bodies: string[] = [];
    await publishDue(pool, { send: async (_url, body) => { bodies.push(body); } }, "q");
    if (!bodies.length) break;
    const response = await run({ Records: [...bodies, ...bodies].map((body, i) => ({ body, messageId: String(i) })) } as import("aws-lambda").SQSEvent);
    expect(response.batchItemFailures).toEqual([]);
  }
  const { rows } = await pool.query<{ state: string; payment_charge_id: string; document_delivery_id: string }>("SELECT state, payment_charge_id, document_delivery_id FROM workflows WHERE id=$1", [workflowId]);
  expect(rows[0]!.state).toBe("DOCUMENTS_DELIVERED");
  expect(rows[0]!.payment_charge_id).toMatch(/^demo-payment-/);
  expect(rows[0]!.document_delivery_id).toMatch(/^demo-document-/);
  expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE workflow_id=$1 AND status!='done'", [workflowId])).rows[0]!.n).toBe(0);
});

it("HTTP replay preserves values and status although JSONB reorders object keys", async () => {
  const { buildServer } = await import("../../src/http/server.js");
  const { createHttpHandler } = await import("../../src/aws/http.js");
  const { createMetrics } = await import("../../src/observability/metrics.js");
  const { createLogger } = await import("@policy/domain/logger");
  const { sampleApplication } = await import("../helpers/db.js");
  const server = buildServer({ pool, log: createLogger("silent"), metrics: createMetrics({ defaultMetrics: false }) });
  try {
    const handle = createHttpHandler(server);
    const request = {
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      rawPath: "/v1/policy-applications", rawQueryString: "", isBase64Encoded: false,
      body: JSON.stringify(sampleApplication),
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
    } as unknown as import("aws-lambda").APIGatewayProxyEventV2;
    const created = await handle(request);
    const replay = await handle(request);
    const decode = (body: string): unknown => JSON.parse(Buffer.from(body, "base64").toString());
    const originalBody = decode(created.body!);
    const replayBody = decode(replay.body!);
    expect(created.statusCode).toBe(202);
    expect(replay.statusCode).toBe(created.statusCode);
    expect(replay.headers?.["idempotent-replayed"]).toBe("true");
    expect(replayBody).toEqual(originalBody);
    // This is the old smoke assertion. It rejects this correct real DB replay.
    expect(JSON.stringify(replayBody)).not.toBe(JSON.stringify(originalBody));
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM workflows")).rows[0]!.n).toBe(1);
  } finally { await server.close(); }
});
