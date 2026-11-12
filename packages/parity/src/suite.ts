import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Steps, WORKFLOW_SPAN_NAME, stepSpanName } from "@policy/domain/steps";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParityDriver, WorkflowView } from "./driver.js";
import { sampleApplication, startWorkflow, submit, view, waitFor } from "./http.js";

/**
 * The parity suite. Each implementation's test file calls
 * `defineParitySuite(createDriver)`; the scenarios, fault settings and
 * expectations below are shared verbatim. A scenario passes only if the
 * workflow ends in the expected state AND no side effect happened twice.
 */

const HAPPY_PATH = [
  "QUOTE_REQUESTED",
  "QUOTE_PRICED",
  "POLICY_BOUND",
  "PAYMENT_CONFIRMED",
  "POLICY_ISSUED",
  "DOCUMENTS_DELIVERED",
] as const;

const HAPPY_CAUSES = ["api", "priced", "auto-bind", /* payment */ undefined, "issued", "documents-delivered"];

export function defineParitySuite(createDriver: () => Promise<ParityDriver>): void {
  let d: ParityDriver;

  beforeAll(async () => {
    d = await createDriver();
  });
  beforeEach(async () => {
    await d.reset();
  });
  afterAll(async () => {
    await d?.close();
  });

  /** Wait for the end, then read the workflow through the public API. */
  const settle = async (id: string): Promise<WorkflowView> => {
    await d.waitUntilSettled(id);
    return view(d.apiUrl, id);
  };

  /** The invariant every scenario ends with. */
  const assertNoDoubleEffects = async (wf: WorkflowView) => {
    const { payment, documents } = d.fakes;
    expect(payment.capturesFor(wf.workflowId), "captures").toBeLessThanOrEqual(1);
    expect(await d.policiesIssued(wf.workflowId), "policy numbers issued").toBeLessThanOrEqual(1);
    if (wf.policyNumber) expect(documents.deliveriesFor(wf.policyNumber), "deliveries").toBeLessThanOrEqual(1);
    const states = wf.transitions.map((t) => t.to);
    expect(new Set(states).size, `states entered: ${states.join(",")}`).toBe(states.length);
  };

  const assertDeliveredOnce = async (wf: WorkflowView) => {
    expect(wf.state).toBe("DOCUMENTS_DELIVERED");
    expect(wf.transitions.map((t) => t.to)).toEqual(HAPPY_PATH);
    expect(d.fakes.payment.capturesFor(wf.workflowId)).toBe(1);
    expect(wf.paymentChargeId).toBe(d.fakes.payment.charges().find((c) => c.reference === wf.workflowId)?.chargeId);
    expect(await d.policiesIssued(wf.workflowId)).toBe(1);
    expect(d.fakes.documents.deliveriesFor(wf.policyNumber!)).toBe(1);
    expect(wf.documentDeliveryId).toBe(d.fakes.documents.deliveries()[0]?.deliveryId);
    expect(wf.deadLetterReason).toBeNull();
    await assertNoDoubleEffects(wf);
  };

  const paymentCause = (wf: WorkflowView) => wf.transitions.find((t) => t.to === "PAYMENT_CONFIRMED")?.cause;

  describe("parity: happy path", () => {
    it("quote -> price -> bind -> pay -> issue -> deliver, each exactly once", async () => {
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      await assertDeliveredOnce(wf);
      expect(wf.premiumCents).toBe(205_500);
      expect(wf.policyNumber).toMatch(/^GL-\d{4}-\d+$/);
      wf.transitions.forEach((t, i) => HAPPY_CAUSES[i] && expect(t.cause).toBe(HAPPY_CAUSES[i]));
      expect(["charge-response", "payment-callback"]).toContain(paymentCause(wf));
    });

    it("a repeated POST with the same Idempotency-Key returns the same workflow", async () => {
      await d.startWorker();
      const first = await submit(d.apiUrl, { key: "parity-replay-key-1" });
      const again = await submit(d.apiUrl, { key: "parity-replay-key-1" });
      const conflict = await submit(d.apiUrl, {
        key: "parity-replay-key-1",
        body: { ...sampleApplication, businessName: "Someone Else" },
      });
      expect(first.status).toBe(202);
      expect(again.status).toBe(202);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(again.body.workflowId).toBe(first.body.workflowId);
      expect(conflict.status).toBe(422);
      await assertDeliveredOnce(await settle(first.body.workflowId as string));
    });

    it("traces: one trace per workflow, with the same step and provider spans", async () => {
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      await settle(id);
      // Span names both implementations must produce, all in one trace.
      const expected = [
        WORKFLOW_SPAN_NAME,
        stepSpanName(Steps.price),
        stepSpanName(Steps.charge),
        "payment.charge",
        stepSpanName(Steps.issue),
        stepSpanName(Steps.deliver),
        "documents.deliver",
      ];
      const spans = await waitFor(
        () => {
          const all = d.spans.getFinishedSpans();
          return expected.every((n) => all.some((s) => s.name === n)) && all;
        },
        { what: `spans ${expected.join(", ")}` },
      );
      const byName = (n: string): ReadableSpan => spans.find((s) => s.name === n)!;
      const traceId = byName(WORKFLOW_SPAN_NAME).spanContext().traceId;
      for (const name of expected) expect(byName(name).spanContext().traceId, name).toBe(traceId);
      // The provider call is nested inside the step that made it.
      expect(isDescendant(spans, byName("payment.charge"), byName(stepSpanName(Steps.charge)))).toBe(true);
      expect(isDescendant(spans, byName("documents.deliver"), byName(stepSpanName(Steps.deliver)))).toBe(true);
      expect(byName(stepSpanName(Steps.charge)).attributes["workflow.id"]).toBe(id);
    });
  });

  describe("parity: duplicate payment callback", () => {
    it("three copies of charge.succeeded move the workflow once and charge once", async () => {
      d.fakes.payment.setFaults({ callbacks: true, callbackCopies: 3, callbackDelayMs: 10 });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      await waitFor(() => d.fakes.payment.capturesFor(id) === 1, { what: "capture" });
      await d.fakes.payment.drainCallbacks();
      const wf = await settle(id);
      expect(d.fakes.payment.callbacksSent()).toBe(3);
      expect(d.fakes.payment.requestCount()).toBe(1);
      await assertDeliveredOnce(wf);
    });
  });

  describe("parity: payment timeout, then late success", () => {
    it("the charge times out, the provider's callback confirms it, and the card is not charged again", async () => {
      // The provider captures at once but answers after 1.5s; the client gives up at 300ms.
      // The success callback arrives ~50ms after the capture.
      d.fakes.payment.setFaults({ responseDelayMs: 1_500, callbacks: true, callbackDelayMs: 50 });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(paymentCause(wf)).toBe("payment-callback");
      await assertDeliveredOnce(wf);
      // Neither implementation calls the provider again once the callback has confirmed the charge.
      await d.fakes.payment.drainCallbacks();
      expect(d.fakes.payment.requestCount()).toBe(1);
    });

    it("without a callback, the retry reuses the idempotency key and gets the original charge", async () => {
      d.fakes.payment.setFaults({ responseDelayMs: 1_000, callbacks: false });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(paymentCause(wf)).toBe("charge-response");
      expect(d.fakes.payment.requestCount()).toBeGreaterThanOrEqual(2);
      await assertDeliveredOnce(wf);
    });

    it("a success that arrives after the workflow failed is flagged for refund, not silently resurrected", async () => {
      // Every charge response is a 500 although the first one captured; the callback lands after retries are exhausted.
      d.fakes.payment.setFaults({ failAfterCaptureNext: 1_000, callbacks: true, callbackDelayMs: 1_500 });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      await waitFor(() => d.fakes.payment.capturesFor(id) === 1, { what: "capture" });
      await waitFor(async () => (await view(d.apiUrl, id)).state === "DEAD_LETTERED", { what: "dead-letter" });
      await d.fakes.payment.drainCallbacks();
      const wf = await settle(id);
      expect(wf.state).toBe("DEAD_LETTERED");
      expect(wf.deadLetterReason).toMatch(/^policy\.bound failed: exhausted 4 attempts: RetryableError: HTTP 500/);
      expect(wf.deadLetterReason).toContain("captured after dead-letter: manual refund required");
      expect(d.fakes.payment.capturesFor(id)).toBe(1);
      expect(await d.policiesIssued(id)).toBe(0);
      await assertNoDoubleEffects(wf);
    });
  });

  describe("parity: payment provider failures", () => {
    it("transient 500s before capture are retried, then succeed", async () => {
      d.fakes.payment.setFaults({ failNext: 3, callbacks: false });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(d.fakes.payment.requestCount()).toBe(4);
      await assertDeliveredOnce(wf);
    });

    it("persistent 500s end in DEAD_LETTERED after the attempt limit, with the reason, and no charge", async () => {
      d.fakes.payment.setFaults({ failNext: 1_000, callbacks: false });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(wf.state).toBe("DEAD_LETTERED");
      expect(wf.deadLetterReason).toMatch(/^policy\.bound failed: exhausted 4 attempts: RetryableError: HTTP 500/);
      expect(wf.transitions.at(-1)).toMatchObject({ from: "POLICY_BOUND", to: "DEAD_LETTERED", cause: "dead-letter:policy.bound" });
      expect(d.fakes.payment.requestCount()).toBe(4);
      expect(d.fakes.payment.capturesFor(id)).toBe(0);
      await assertNoDoubleEffects(wf);
    });

    it("a declined card (4xx) is non-retryable: one attempt, then DEAD_LETTERED", async () => {
      d.fakes.payment.setFaults({ declineNext: 1 });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(wf.state).toBe("DEAD_LETTERED");
      expect(wf.deadLetterReason).toMatch(/^policy\.bound failed: non-retryable: NonRetryableError: HTTP 402/);
      expect(wf.deadLetterReason).toContain("card_declined");
      expect(d.fakes.payment.requestCount()).toBe(1);
      expect(d.fakes.payment.capturesFor(id)).toBe(0);
    });
  });

  describe("parity: document service down", () => {
    it("retries, then DEAD_LETTERED with the 503 in the reason; paid and issued exactly once", async () => {
      d.fakes.documents.setFaults({ down: true });
      d.fakes.payment.setFaults({ callbacks: false });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(wf.state).toBe("DEAD_LETTERED");
      expect(wf.deadLetterReason).toMatch(/^policy\.issued failed: exhausted 4 attempts: RetryableError: HTTP 503/);
      expect(wf.transitions.map((t) => t.to)).toEqual([...HAPPY_PATH.slice(0, 5), "DEAD_LETTERED"]);
      expect(wf.policyNumber).toMatch(/^GL-/);
      expect(d.fakes.payment.capturesFor(id)).toBe(1);
      expect(await d.policiesIssued(id)).toBe(1);
      expect(d.fakes.documents.requestCount()).toBe(4);
      expect(d.fakes.documents.deliveries()).toHaveLength(0);
      await assertNoDoubleEffects(wf);
    });

    it("recovers if the service comes back within the retry budget", async () => {
      d.fakes.documents.setFaults({ failNext: 2 });
      await d.startWorker();
      const id = await startWorkflow(d.apiUrl);
      const wf = await settle(id);
      expect(d.fakes.documents.requestCount()).toBe(3);
      await assertDeliveredOnce(wf);
    });
  });

  describe("parity: worker killed mid-workflow", () => {
    const cases = [
      // The dangerous one: the card was charged, but the worker died before recording it.
      { point: `after-side-effect:${Steps.charge}`, captured: true, delivered: false },
      // Documents went out, but the worker died before recording that.
      { point: `after-side-effect:${Steps.deliver}`, captured: true, delivered: true },
    ];
    for (const c of cases) {
      it(`SIGKILL at ${c.point}: a fresh worker finishes without repeating the side effect`, async () => {
        d.fakes.payment.setFaults({ callbacks: false }); // only a worker may move payment forward
        const crashing = await d.startCrashingWorker(c.point);
        const id = await startWorkflow(d.apiUrl);
        await crashing.exited;
        expect(d.fakes.payment.capturesFor(id)).toBe(c.captured ? 1 : 0);
        expect(d.fakes.documents.deliveries().length).toBe(c.delivered ? 1 : 0);

        await d.startWorker();
        const wf = await settle(id);
        await assertDeliveredOnce(wf);
        // The side effect was repeated with the same idempotency key and replayed by the provider.
        if (!c.delivered) expect(d.fakes.payment.requestCount()).toBe(2);
        else expect(d.fakes.documents.requestCount()).toBe(2);
      });
    }
  });
}

function isDescendant(spans: readonly ReadableSpan[], child: ReadableSpan, ancestor: ReadableSpan): boolean {
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  let parentId = parentSpanId(child);
  while (parentId) {
    if (parentId === ancestor.spanContext().spanId) return true;
    const parent = byId.get(parentId);
    parentId = parent ? parentSpanId(parent) : undefined;
  }
  return false;
}

/** OTel SDK 2.x uses `parentSpanContext`; 1.x (used inside Temporal's workflow sandbox) used `parentSpanId`. */
function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId ?? (span as unknown as { parentSpanId?: string }).parentSpanId;
}
