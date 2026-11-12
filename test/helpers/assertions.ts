import { expect } from "vitest";
import { getWorkflow } from "../../src/workflow/repository.js";
import { statesEntered, type Harness } from "./harness.js";

/**
 * The invariant every fault test ends with: whatever went wrong on the way,
 * no external side effect happened more than once and no state was entered
 * more than once.
 */
export async function assertNoDuplicateEffects(h: Harness, workflowId: string): Promise<void> {
  expect(h.payment.capturesFor(workflowId), "captures for workflow").toBeLessThanOrEqual(1);
  const wf = await getWorkflow(h.pool, workflowId);
  if (wf?.policyNumber) {
    expect(h.documents.deliveriesFor(wf.policyNumber), "document deliveries").toBeLessThanOrEqual(1);
  }
  const states = await statesEntered(h.pool, workflowId);
  expect(new Set(states).size, `states entered: ${states.join(",")}`).toBe(states.length);
  // Exactly one event announces each state change; duplicates were never
  // re-emitted. (Rows injected by a test to simulate redelivery are excluded.)
  const { rows } = await h.pool.query<{ type: string; n: string }>(
    `SELECT type, count(*) AS n FROM outbox WHERE workflow_id = $1 AND NOT (payload ? 'injected')
      GROUP BY type HAVING count(*) > 1`,
    [workflowId],
  );
  expect(rows, "outbox event types emitted more than once").toEqual([]);
}

/** Successful completion with exactly one capture and one delivery. */
export async function assertCompletedOnce(h: Harness, workflowId: string): Promise<void> {
  const wf = await getWorkflow(h.pool, workflowId);
  expect(wf?.state).toBe("DOCUMENTS_DELIVERED");
  expect(h.payment.capturesFor(workflowId)).toBe(1);
  expect(h.documents.deliveriesFor(wf!.policyNumber!)).toBe(1);
  await assertNoDuplicateEffects(h, workflowId);
}
