import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/pool.js";
import { silentLogger } from "../../src/observability/logger.js";
import { createMetrics } from "../../src/observability/metrics.js";
import { enqueue } from "../../src/outbox/outbox.js";
import { getWorkflow, lockWorkflow, transition } from "../../src/workflow/repository.js";
import { assertCompletedOnce } from "../helpers/assertions.js";
import { createTestWorkflow, outboxRows } from "../helpers/db.js";
import {
  HAPPY_PATH,
  metricValue,
  outboxSettled,
  startHarness,
  startWorkflow,
  statesEntered,
  waitFor,
  waitForState,
  type Harness,
} from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

/** Simulate the queue redelivering an event: a second copy of the same step event. */
async function redeliver(workflowId: string, type: string, copies = 1) {
  await withTransaction(h.pool, async (tx) => {
    for (let i = 0; i < copies; i++) await enqueue(tx, { workflowId, type, payload: { injected: true } });
  });
}

const STEP_EVENTS = ["quote.requested", "quote.priced", "policy.bound", "payment.confirmed", "policy.issued"];

describe("fault: duplicate event delivery", () => {
  it("redelivering every step event after completion changes nothing", async () => {
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    const before = await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    await waitFor(() => outboxSettled(h.pool, id));
    const chargeRequests = h.payment.requestCount();

    for (const type of STEP_EVENTS) await redeliver(id, type, 2);
    await waitFor(() => outboxSettled(h.pool, id), { what: "duplicates processed" });

    const after = await getWorkflow(h.pool, id);
    expect(after).toEqual(before);
    expect(h.payment.requestCount()).toBe(chargeRequests); // stale events never reach the provider
    expect(await statesEntered(h.pool, id)).toEqual(HAPPY_PATH);
    expect(await metricValue(worker, "duplicates_suppressed_total", { kind: "event" })).toBeGreaterThanOrEqual(10);
    await assertCompletedOnce(h, id);
  });

  it("duplicates claimed in the same batch race; exactly one wins each step", async () => {
    const id = await createTestWorkflow(h.pool);
    await redeliver(id, "quote.requested", 4); // five copies in total, all due now
    await h.startWorker({ relay: { pollIntervalMs: 20, batchSize: 10, leaseMs: 2_000 } });
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    await waitFor(() => outboxSettled(h.pool, id));
    expect(await statesEntered(h.pool, id)).toEqual(HAPPY_PATH);
    await assertCompletedOnce(h, id);
  });

  it("concurrent duplicate payment steps charge once and emit one confirmation", async () => {
    h.payment.setFaults({ callbacks: false, responseDelayMs: 100 });
    const id = await createTestWorkflow(h.pool);
    // Fast-forward the workflow to POLICY_BOUND directly, then add two extra copies of policy.bound.
    const deps = { log: silentLogger(), metrics: createMetrics({ defaultMetrics: false }) };
    await withTransaction(h.pool, async (tx) => {
      await tx.query("UPDATE outbox SET status = 'done' WHERE workflow_id = $1", [id]);
      const requested = await lockWorkflow(tx, id);
      const wf = await transition(tx, deps, { workflow: requested, to: "QUOTE_PRICED", cause: "test", patch: { premiumCents: 77_700 } });
      await transition(tx, deps, { workflow: wf, to: "POLICY_BOUND", cause: "test", event: { type: "policy.bound" } });
    });
    await redeliver(id, "policy.bound", 2);

    await h.startWorker();
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    await waitFor(() => outboxSettled(h.pool, id));
    expect(h.payment.requestCount()).toBe(3); // all three ran concurrently...
    expect(h.payment.capturesFor(id)).toBe(1); // ...but the shared key meant one capture
    const confirmations = (await outboxRows(h.pool, id)).filter((r) => r.type === "payment.confirmed");
    expect(confirmations).toHaveLength(1);
    await assertCompletedOnce(h, id);
  });
});

describe("fault: duplicate payment callbacks", () => {
  it("applies the first callback and acknowledges the copies without effect", async () => {
    // Provider answers slowly so the callback confirms first, then sends two more copies.
    h.payment.setFaults({ callbacks: true, callbackCopies: 3, callbackDelayMs: 30, responseDelayMs: 250 });
    await h.startWorker({ externalCallTimeoutMs: 2_000 });
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    await h.payment.drainCallbacks();

    const { rows } = await h.pool.query<{ event_id: string; outcome: string }>(
      "SELECT event_id, outcome FROM inbound_events WHERE workflow_id = $1",
      [id],
    );
    expect(rows).toHaveLength(1); // one row per provider event id, however many copies arrived
    expect(rows[0]?.outcome).toBe("confirmed");
    expect(h.payment.callbacksSent()).toBe(3);
    expect(await metricValue(h.api, "duplicates_suppressed_total", { kind: "payment-callback" })).toBe(2);
    await assertCompletedOnce(h, id);
  });

  it("a replayed callback after completion is a no-op", async () => {
    h.payment.setFaults({ callbacks: false });
    await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    const done = await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    const post = (eventId: string) =>
      fetch(`${h.apiUrl}/webhooks/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, type: "charge.succeeded", chargeId: done.paymentChargeId, reference: id }),
      }).then((r) => r.json() as Promise<{ outcome: string }>);

    expect((await post("evt_late_1")).outcome).toBe("already-confirmed");
    expect((await post("evt_late_1")).outcome).toBe("duplicate");
    expect(await getWorkflow(h.pool, id)).toEqual(done);
    await assertCompletedOnce(h, id);
  });
});
