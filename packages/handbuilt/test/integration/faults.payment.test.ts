import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getWorkflow, listTransitions } from "../../src/workflow/repository.js";
import { assertCompletedOnce, assertNoDuplicateEffects } from "../helpers/assertions.js";
import { outboxRows } from "../helpers/db.js";
import {
  metricValue,
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

const confirmationCause = async (id: string) =>
  (await listTransitions(h.pool, id)).find((t) => t.to === "PAYMENT_CONFIRMED")?.cause;

describe("fault: payment provider timeout, then late success", () => {
  it("callback confirms the late capture; the retry finds it confirmed and does nothing", async () => {
    // Provider captures immediately but answers after 1.5s; the client gives up at 300ms.
    // The callback arrives ~50ms after capture.
    h.payment.setFaults({ responseDelayMs: 1_500, callbacks: true, callbackDelayMs: 50 });
    // Long first backoff, so the callback clearly wins the race to confirm.
    const worker = await h.startWorker({ retry: { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 2_000 } }, { random: () => 0.5 });
    const id = await startWorkflow(h.apiUrl);

    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(await confirmationCause(id)).toBe("payment-callback");
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.bound" })).toBe(1);
    await assertCompletedOnce(h, id);
    // The timed-out attempt is retried later, sees PAYMENT_CONFIRMED and is acknowledged without charging.
    await waitFor(async () => (await outboxRows(h.pool, id)).every((r) => r.status === "done"), { what: "outbox drained" });
    expect(h.payment.requestCount()).toBe(1);
    expect(await metricValue(worker, "duplicates_suppressed_total", { kind: "event" })).toBeGreaterThanOrEqual(1);
  });

  it("without a callback, the retry reuses the idempotency key and gets the original charge", async () => {
    h.payment.setFaults({ responseDelayMs: 1_000, callbacks: false });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);

    const wf = await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(await confirmationCause(id)).toBe("charge-response");
    expect(h.payment.requestCount()).toBeGreaterThanOrEqual(2);
    expect(wf.paymentChargeId).toBe(h.payment.charges()[0]!.chargeId);
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.bound" })).toBeGreaterThanOrEqual(1);
    await assertCompletedOnce(h, id);
  });

  it("a 500 after the money moved (ambiguous failure) is retried without a second capture", async () => {
    h.payment.setFaults({ failAfterCaptureNext: 2, callbacks: false });
    await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(h.payment.requestCount()).toBe(3);
    await assertCompletedOnce(h, id);
  });

  it("transient 500s before capture are retried with backoff and then succeed", async () => {
    h.payment.setFaults({ failNext: 3, callbacks: false });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.bound" })).toBe(3);
    await assertCompletedOnce(h, id);
  });
});

describe("fault: payment permanently failing", () => {
  it("dead-letters after the attempt limit with a reason, and nothing is charged", async () => {
    h.payment.setFaults({ failNext: 1_000, callbacks: false });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    const wf = await waitForState(h.pool, id, "DEAD_LETTERED");
    expect(wf.deadLetterReason).toMatch(/^policy\.bound failed: exhausted 4 attempts: RetryableError: HTTP 500/);
    expect(h.payment.requestCount()).toBe(4);
    expect(h.payment.capturesFor(id)).toBe(0);
    expect(await metricValue(worker, "workflows_failed_total", { step: "policy.bound" })).toBe(1);
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.bound" })).toBe(3);
    const bound = (await outboxRows(h.pool, id)).find((r) => r.type === "policy.bound");
    expect(bound).toMatchObject({ status: "dead", attempts: 4 });
    await assertNoDuplicateEffects(h, id);
  });

  it("a declined card is not retried", async () => {
    h.payment.setFaults({ declineNext: 1 });
    await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    const wf = await waitForState(h.pool, id, "DEAD_LETTERED");
    expect(wf.deadLetterReason).toContain("non-retryable");
    expect(wf.deadLetterReason).toContain("card_declined");
    expect(h.payment.requestCount()).toBe(1);
    expect(h.payment.capturesFor(id)).toBe(0);
  });

  it("flags a capture that is confirmed only after the workflow was dead-lettered", async () => {
    // Every response is a 500 even though the first request captured; the
    // callback is slow and arrives after the retries are exhausted.
    h.payment.setFaults({ failAfterCaptureNext: 1_000, callbacks: true, callbackDelayMs: 1_500 });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DEAD_LETTERED");
    await h.payment.drainCallbacks();

    const wf = await getWorkflow(h.pool, id);
    expect(wf?.state).toBe("DEAD_LETTERED"); // not silently resurrected
    expect(wf?.deadLetterReason).toContain("captured after dead-letter: manual refund required");
    expect(h.payment.capturesFor(id)).toBe(1);
    expect(await metricValue(h.api, "payment_captured_after_dead_letter_total")).toBe(1);
    expect(await metricValue(worker, "workflows_failed_total")).toBe(1);
    await assertNoDuplicateEffects(h, id);
  });
});

describe("fault: transient pricing failure", () => {
  it("retries the pricing step and completes", async () => {
    const { flakyPricing } = await import("../../src/domain/pricing.js");
    const worker = await h.startWorker({}, { pricing: flakyPricing(2) });
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "quote.requested" })).toBe(2);
    await assertCompletedOnce(h, id);
  });
});
