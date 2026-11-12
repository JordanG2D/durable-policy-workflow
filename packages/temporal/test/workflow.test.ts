import { startWorkflow, view, waitFor } from "@policy/parity/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentConfirmedSignal, stateQuery } from "../src/definitions.js";
import { DEFAULT_RETRY } from "../src/workflows.js";
import { startTemporalHarness, type TemporalHarness } from "./support/harness.js";

/**
 * Temporal-specific behaviour the shared parity suite cannot express:
 * the state query, signals sent directly, callbacks for closed workflows,
 * and production retry policies under time skipping.
 */
const fast = { maxAttempts: 4, initialIntervalMs: 20, maxIntervalMs: 100 };
const fastConfig = {
  retry: { "quote.requested": fast, "policy.bound": fast, "payment.confirmed": fast, "policy.issued": fast },
  activityTimeoutMs: 3_000,
  chargeHeartbeatTimeoutMs: 1_000,
};

let h: TemporalHarness;
beforeAll(async () => {
  h = await startTemporalHarness(fastConfig);
});
beforeEach(async () => {
  await h.reset();
  await h.useWorkflowConfig(fastConfig);
});
afterAll(async () => {
  await h?.close();
});

const webhook = (body: Record<string, string>) =>
  fetch(`${h.apiUrl}/webhooks/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<{ outcome: string }>);

describe("query: current workflow state", () => {
  it("reports the in-flight state, premium and transitions while payment is pending", async () => {
    h.payment.setFaults({ responseDelayMs: 2_000, callbacks: false });
    await h.startWorker({ timeoutMs: 2_500 });
    const id = await startWorkflow(h.apiUrl);
    const snap = await waitFor(
      async () => {
        const s = await h.env.client.workflow.getHandle(id).query(stateQuery);
        return s.state === "POLICY_BOUND" && s;
      },
      { what: "POLICY_BOUND" },
    );
    expect(snap).toMatchObject({ workflowId: id, premiumCents: 205_500, paymentChargeId: null, deadLetterReason: null });
    expect(snap.transitions.map((t) => t.to)).toEqual(["QUOTE_REQUESTED", "QUOTE_PRICED", "POLICY_BOUND"]);
    await h.waitUntilSettled(id);
    expect((await view(h.apiUrl, id)).state).toBe("DOCUMENTS_DELIVERED");
  });

  it("404s for an unknown workflow", async () => {
    const res = await fetch(`${h.apiUrl}/v1/policy-applications/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe("signal: duplicate, early and late payment confirmations", () => {
  it("first confirmation wins; a repeated event is counted; a different charge is flagged", async () => {
    // Slow charge response so the signal arrives first; slow documents keep the workflow open afterwards.
    h.payment.setFaults({ responseDelayMs: 1_000, callbacks: false });
    h.documents.setFaults({ responseDelayMs: 1_500 });
    await h.startWorker({ timeoutMs: 2_500 });
    const id = await startWorkflow(h.apiUrl);
    await waitFor(() => h.payment.capturesFor(id) === 1, { what: "capture" });
    const { chargeId } = h.payment.charges()[0]!;
    const handle = h.env.client.workflow.getHandle(id);

    await handle.signal(paymentConfirmedSignal, { eventId: "evt_1", chargeId });
    await handle.signal(paymentConfirmedSignal, { eventId: "evt_1", chargeId }); // same event redelivered
    await waitFor(async () => (await handle.query(stateQuery)).state !== "POLICY_BOUND", { what: "confirmation" });
    await handle.signal(paymentConfirmedSignal, { eventId: "evt_2", chargeId }); // new event, same charge
    await handle.signal(paymentConfirmedSignal, { eventId: "evt_3", chargeId: "ch_someone_else" });

    await h.waitUntilSettled(id);
    const s = await handle.query(stateQuery);
    expect(s.state).toBe("DOCUMENTS_DELIVERED");
    expect(s.transitions.find((t) => t.to === "PAYMENT_CONFIRMED")?.cause).toBe("payment-callback");
    expect(s.paymentChargeId).toBe(chargeId);
    expect(s.duplicateSignals).toBe(2);
    expect(s.anomalies).toEqual([expect.stringContaining("second distinct charge ch_someone_else")]);
    expect(h.payment.capturesFor(id)).toBe(1);
  });

  it("a callback for a workflow that has already closed is reported, not lost silently", async () => {
    h.payment.setFaults({ callbacks: false });
    await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    await h.waitUntilSettled(id);
    const late = await webhook({ eventId: "evt_late", type: "charge.succeeded", chargeId: "ch_late", reference: id });
    expect(late.outcome).toBe("workflow-closed");
    const unknown = await webhook({
      eventId: "evt_x",
      type: "charge.succeeded",
      chargeId: "ch_x",
      reference: "00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.outcome).toBe("unknown-workflow");
    expect((await webhook({ eventId: "e", type: "charge.refunded", chargeId: "c", reference: id })).outcome).toBe("ignored-type");
  });
});

describe("time skipping: production retry policies", () => {
  it("documents down: 8 attempts over ~2 minutes of backoff plus a 24h grace window, in seconds", async (ctx) => {
    if (!h.env.supportsTimeSkipping) ctx.skip(); // needs the time-skipping test server
    await h.useWorkflowConfig(undefined); // the workflow's real defaults
    h.payment.setFaults({ callbacks: false });
    h.documents.setFaults({ down: true });
    await h.startWorker();
    const startedAt = Date.now();
    const serverStart = await h.env.currentTimeMs();
    const id = await startWorkflow(h.apiUrl);
    await h.waitUntilSettled(id, 40_000);

    const wf = await view(h.apiUrl, id);
    const attempts = DEFAULT_RETRY["policy.issued"].maxAttempts;
    expect(wf.state).toBe("DEAD_LETTERED");
    expect(wf.deadLetterReason).toMatch(new RegExp(`^policy\\.issued failed: exhausted ${attempts} attempts: RetryableError: HTTP 503`));
    expect(h.documents.requestCount()).toBe(attempts);
    // The server's clock moved past the 24h late-capture window; the wall clock did not.
    expect((await h.env.currentTimeMs()) - serverStart).toBeGreaterThan(24 * 60 * 60 * 1_000);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });
});

