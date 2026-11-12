import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertCompletedOnce, assertNoDuplicateEffects } from "../helpers/assertions.js";
import { outboxRows } from "../helpers/db.js";
import { metricValue, startHarness, startWorkflow, waitForState, type Harness } from "../helpers/harness.js";

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

describe("fault: document service down", () => {
  it("retries, then dead-letters with the reason; the policy stays issued and paid once", async () => {
    h.documents.setFaults({ down: true });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);

    const wf = await waitForState(h.pool, id, "DEAD_LETTERED");
    expect(wf.deadLetterReason).toMatch(/^policy\.issued failed: exhausted 4 attempts: RetryableError: HTTP 503/);
    expect(wf.policyNumber).toMatch(/^GL-/); // issued before delivery failed
    expect(h.documents.requestCount()).toBe(4);
    expect(h.documents.deliveries()).toHaveLength(0);
    expect(h.payment.capturesFor(id)).toBe(1);
    expect(await metricValue(worker, "workflows_failed_total", { step: "policy.issued" })).toBe(1);
    expect((await outboxRows(h.pool, id)).find((r) => r.type === "policy.issued")).toMatchObject({
      status: "dead",
      attempts: 4,
    });
    await assertNoDuplicateEffects(h, id);
  });

  it("recovers if the service comes back within the retry budget, delivering once", async () => {
    h.documents.setFaults({ failNext: 2 });
    const worker = await h.startWorker();
    const id = await startWorkflow(h.apiUrl);
    await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(h.documents.requestCount()).toBe(3);
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.issued" })).toBe(2);
    await assertCompletedOnce(h, id);
  });

  it("an unreachable host (connection refused) is retried like a 5xx", async () => {
    const worker = await h.startWorker({ documentServiceUrl: "http://127.0.0.1:1" });
    const id = await startWorkflow(h.apiUrl);
    const wf = await waitForState(h.pool, id, "DEAD_LETTERED");
    expect(wf.deadLetterReason).toContain("network error");
    expect(await metricValue(worker, "workflow_step_retries_total", { step: "policy.issued" })).toBe(3);
  });
});
