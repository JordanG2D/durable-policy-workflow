import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowState } from "@policy/domain/stateMachine";
import { getWorkflow } from "../../src/workflow/repository.js";
import { assertCompletedOnce } from "../helpers/assertions.js";
import { outboxRows } from "../helpers/db.js";
import { spawnWorker as spawnWorkerProcess } from "../helpers/workerProcess.js";
import { HAPPY_PATH, startHarness, startWorkflow, statesEntered, waitFor, waitForState, type Harness } from "../helpers/harness.js";

/**
 * Crash recovery with real process death. The worker runs as a separate Node
 * process and SIGKILLs itself at a chosen point (see @policy/domain/crash), or
 * is SIGKILLed by the test at random moments. A fresh worker must then finish
 * every workflow without repeating any side effect.
 */

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
beforeEach(async () => {
  await h.reset();
  h.payment.setFaults({ callbacks: false }); // only the worker may move payment forward here
});
afterAll(async () => {
  await h.close();
});

const spawnWorker = (env: Record<string, string> = {}) => spawnWorkerProcess(h, env);

const recover = () =>
  h.startWorker({ relay: { pollIntervalMs: 20, batchSize: 10, leaseMs: 2_000 }, retry: { maxAttempts: 6, baseDelayMs: 20, maxDelayMs: 100 } });

interface CrashCase {
  point: string;
  /** State the workflow is left in by the dead worker. */
  stateAtCrash: WorkflowState;
  captures: number;
  deliveries: number;
}

const cases: CrashCase[] = [
  // Killed holding a lease before doing anything: the lease must expire and be reclaimed.
  { point: "after-claim:policy.bound", stateAtCrash: "POLICY_BOUND", captures: 0, deliveries: 0 },
  // The dangerous one: the card was charged but the DB never heard about it.
  { point: "after-side-effect:policy.bound", stateAtCrash: "POLICY_BOUND", captures: 1, deliveries: 0 },
  // Killed between steps: committed, next step not yet claimed.
  { point: "after-commit:payment.confirmed", stateAtCrash: "POLICY_ISSUED", captures: 1, deliveries: 0 },
  // Documents sent, DB not updated.
  { point: "after-side-effect:policy.issued", stateAtCrash: "POLICY_ISSUED", captures: 1, deliveries: 1 },
];

describe("fault: worker killed mid-workflow (SIGKILL)", () => {
  for (const c of cases) {
    it(`resumes after a crash at ${c.point} without repeating side effects`, async () => {
      const id = await startWorkflow(h.apiUrl);
      const { exited } = spawnWorker({ CRASH_AT: c.point });
      expect(await exited).toBe("SIGKILL");

      // What the dead worker left behind.
      const atCrash = await getWorkflow(h.pool, id);
      expect(atCrash?.state).toBe(c.stateAtCrash);
      expect(h.payment.capturesFor(id)).toBe(c.captures);
      expect(h.documents.deliveries()).toHaveLength(c.deliveries);

      const requestsBefore = h.payment.requestCount() + h.documents.requestCount();
      await recover();
      await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
      expect(await statesEntered(h.pool, id)).toEqual(HAPPY_PATH);
      await assertCompletedOnce(h, id);
      if (c.point.startsWith("after-side-effect")) {
        // The step really did run again; the idempotency key made the repeat harmless.
        expect(h.payment.requestCount() + h.documents.requestCount()).toBeGreaterThan(requestsBefore);
      }
    });
  }

  it("survives repeated random SIGKILLs across many workflows", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => startWorkflow(h.apiUrl)));
    h.payment.setFaults({ responseDelayMs: 120, callbacks: false });
    h.documents.setFaults({ responseDelayMs: 120 });
    const progress = async () => {
      const { rows } = await h.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM workflow_transitions WHERE workflow_id = ANY($1)",
        [ids],
      );
      return Number(rows[0]!.n);
    };

    let killedMidWork = 0;
    for (let round = 0; round < 8; round++) {
      const before = await progress();
      const { child, exited } = spawnWorker({ RELAY_BATCH_SIZE: "3" });
      // Wait until this worker has made some progress, then kill it at a random moment.
      await waitFor(async () => (await progress()) > before, { timeoutMs: 15_000, intervalMs: 10, what: "worker progress" });
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 150)));
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      const states = await Promise.all(ids.map(async (id) => (await getWorkflow(h.pool, id))?.state));
      if (states.every((st) => st === "DOCUMENTS_DELIVERED")) break;
      killedMidWork++;
    }
    // Kills really landed while workflows were in flight.
    expect(killedMidWork).toBeGreaterThan(1);

    await recover();
    for (const id of ids) {
      await waitForState(h.pool, id, "DOCUMENTS_DELIVERED", 20_000);
      await assertCompletedOnce(h, id);
    }
    const rows = await outboxRows(h.pool);
    expect(rows.filter((r) => r.status === "dead")).toEqual([]);
  }, 90_000);
});
