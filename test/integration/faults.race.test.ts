import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listTransitions } from "../../src/workflow/repository.js";
import { assertCompletedOnce } from "../helpers/assertions.js";
import {
  metricValue,
  outboxSettled,
  startHarness,
  startWorkflow,
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

describe("fault: workers racing for the same outbox rows", () => {
  it("three workers drain 15 workflows; every effect happens exactly once", async () => {
    const ids = await Promise.all(Array.from({ length: 15 }, () => startWorkflow(h.apiUrl)));
    const relay = { pollIntervalMs: 5, batchSize: 3, leaseMs: 2_000 };
    const workers = await Promise.all([1, 2, 3].map(() => h.startWorker({ relay })));
    await Promise.all(ids.map((id) => waitForState(h.pool, id, "DOCUMENTS_DELIVERED", 20_000)));
    for (const id of ids) await assertCompletedOnce(h, id);

    // The work really was shared.
    const perWorker = await Promise.all(
      workers.map((w) => metricValue(w, "workflow_step_duration_seconds", { step: "quote.requested" })),
    );
    expect(perWorker.filter((n) => n > 0).length).toBeGreaterThan(1);
  });

  it("a worker whose lease expired mid-step is fenced out; the reclaiming worker's result stands", async () => {
    // Worker A's lease is 300ms, but the provider takes 1s to answer its first charge.
    h.payment.setFaults({ responseDelayMs: 1_000, callbacks: false });
    const slow = await h.startWorker({
      relay: { pollIntervalMs: 20, batchSize: 10, leaseMs: 300 },
      externalCallTimeoutMs: 5_000,
    });
    const id = await startWorkflow(h.apiUrl);
    await waitFor(async () => h.payment.requestCount() === 1, { what: "worker A in the slow charge" });

    // Worker B starts while A is still waiting; once A's lease lapses B reclaims
    // the row, replays the charge (same key, instant answer) and moves on.
    const fast = await h.startWorker({ relay: { pollIntervalMs: 20, batchSize: 10, leaseMs: 5_000 } });
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    await waitFor(async () => (await metricValue(slow, "outbox_lease_lost_total")) === 1, {
      what: "worker A to discover it lost the lease",
    });
    await waitFor(() => outboxSettled(h.pool, id));

    expect(h.payment.requestCount()).toBe(2);
    const confirmations = (await listTransitions(h.pool, id)).filter((t) => t.to === "PAYMENT_CONFIRMED");
    expect(confirmations).toHaveLength(1);
    expect(await metricValue(fast, "workflow_step_duration_seconds", { step: "policy.bound", outcome: "ok" })).toBe(1);
    await assertCompletedOnce(h, id);
  });
});
