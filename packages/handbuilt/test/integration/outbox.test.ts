import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withTransaction, type Pool } from "../../src/db/pool.js";
import { NonRetryableError, RetryableError } from "@policy/domain/errors";
import { LeaseLostError } from "../../src/outbox/errors.js";
import { silentLogger } from "@policy/domain/logger";
import { createMetrics } from "../../src/observability/metrics.js";
import { claimBatch, completeWithFence, enqueue } from "../../src/outbox/outbox.js";
import { Relay, type StepHandler } from "../../src/outbox/relay.js";
import { getWorkflow, lockWorkflow, transition } from "../../src/workflow/repository.js";
import { TEST_DATABASE_URL, createTestWorkflow, outboxRows, resetDb, setupDb } from "../helpers/db.js";

let pool: Pool;
const deps = { log: silentLogger(), metrics: createMetrics({ defaultMetrics: false }) };

beforeEach(async () => {
  pool ??= await setupDb();
  await resetDb(pool);
});
afterAll(async () => {
  await pool.end();
});

function relay(handlers: Record<string, StepHandler>, overrides: Partial<ConstructorParameters<typeof Relay>[0]> = {}) {
  const deadLettered: { workflowId: string; reason: string }[] = [];
  const r = new Relay({
    pool,
    handlers,
    onDeadLetter: (_tx, claim, reason) => {
      deadLettered.push({ workflowId: claim.workflowId, reason });
      return Promise.resolve();
    },
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    metrics: createMetrics({ defaultMetrics: false }),
    logger: silentLogger(),
    pollIntervalMs: 10,
    batchSize: 10,
    leaseMs: 5_000,
    ...overrides,
  });
  return { relay: r, deadLettered };
}

describe("transactional outbox", () => {
  it("writes the state change and its event in one transaction", async () => {
    const id = await createTestWorkflow(pool);
    await withTransaction(pool, async (tx) => {
      const wf = await lockWorkflow(tx, id);
      await transition(tx, deps, {
        workflow: wf,
        to: "QUOTE_PRICED",
        cause: "test",
        patch: { premiumCents: 1234 },
        event: { type: "quote.priced" },
      });
    });
    expect((await getWorkflow(pool, id))?.state).toBe("QUOTE_PRICED");
    expect((await outboxRows(pool, id)).map((r) => r.type)).toEqual(["quote.requested", "quote.priced"]);
  });

  it("rolls back both the state change and the event if the transaction fails", async () => {
    const id = await createTestWorkflow(pool);
    await expect(
      withTransaction(pool, async (tx) => {
        const wf = await lockWorkflow(tx, id);
        await transition(tx, deps, { workflow: wf, to: "QUOTE_PRICED", cause: "test", event: { type: "quote.priced" } });
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    expect((await getWorkflow(pool, id))?.state).toBe("QUOTE_REQUESTED");
    expect((await outboxRows(pool, id)).map((r) => r.type)).toEqual(["quote.requested"]);
  });

  it("rejects and does not persist an illegal transition", async () => {
    const id = await createTestWorkflow(pool);
    const metrics = createMetrics({ defaultMetrics: false });
    await expect(
      withTransaction(pool, async (tx) => {
        const wf = await lockWorkflow(tx, id);
        await transition(tx, { log: silentLogger(), metrics }, { workflow: wf, to: "POLICY_ISSUED", cause: "test", event: { type: "policy.issued" } });
      }),
    ).rejects.toThrow("illegal workflow transition QUOTE_REQUESTED -> POLICY_ISSUED");
    expect((await getWorkflow(pool, id))?.state).toBe("QUOTE_REQUESTED");
    expect(await outboxRows(pool, id)).toHaveLength(1);
    const metric = await metrics.illegalTransitions.get();
    expect(metric.values[0]).toMatchObject({ value: 1, labels: { from: "QUOTE_REQUESTED", to: "POLICY_ISSUED" } });
  });

  it("two relays racing over the same rows never claim one row twice (SKIP LOCKED)", async () => {
    const id = await createTestWorkflow(pool);
    await withTransaction(pool, async (tx) => {
      for (let i = 0; i < 199; i++) await enqueue(tx, { workflowId: id, type: "noop" });
    });
    const poolA = createPool(TEST_DATABASE_URL, 4);
    const poolB = createPool(TEST_DATABASE_URL, 4);
    try {
      const claimedBy = new Map<string, string[]>();
      const drain = async (p: Pool, owner: string) => {
        for (;;) {
          const batch = await claimBatch(p, owner, 7, 60_000);
          if (batch.length === 0) return;
          for (const c of batch) claimedBy.set(c.id, [...(claimedBy.get(c.id) ?? []), owner]);
        }
      };
      await Promise.all([drain(poolA, "A"), drain(poolB, "B"), drain(poolA, "A2"), drain(poolB, "B2")]);
      expect(claimedBy.size).toBe(200);
      for (const owners of claimedBy.values()) expect(owners).toHaveLength(1);
      // Both sides actually participated, so this was a real race.
      const owners = new Set([...claimedBy.values()].flat());
      expect(owners.size).toBeGreaterThan(1);
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });

  it("an expired lease is reclaimed and the stale owner is fenced out", async () => {
    const id = await createTestWorkflow(pool);
    const [first] = await claimBatch(pool, "worker-1", 1, 200);
    expect(first).toBeDefined();
    // Still leased: nobody else can take it.
    expect(await claimBatch(pool, "worker-2", 1, 200)).toHaveLength(0);
    await sleep(300);
    const [second] = await claimBatch(pool, "worker-2", 1, 5_000);
    expect(second?.id).toBe(first!.id);
    expect(second?.attempts).toBe(2);
    expect(second?.leaseToken).not.toBe(first!.leaseToken);

    // worker-1 wakes up and tries to commit: rejected, nothing written.
    await expect(withTransaction(pool, (tx) => completeWithFence(tx, first!))).rejects.toThrow(LeaseLostError);
    expect((await outboxRows(pool, id))[0]?.status).toBe("pending");

    await withTransaction(pool, (tx) => completeWithFence(tx, second!));
    expect((await outboxRows(pool, id))[0]?.status).toBe("done");
  });
});

describe("outbox relay", () => {
  it("acknowledges events, including types with no handler", async () => {
    const id = await createTestWorkflow(pool);
    const seen: string[] = [];
    const { relay: r } = relay({
      "quote.requested": (ctx) => {
        seen.push(ctx.claim.type);
        return Promise.resolve();
      },
    });
    await withTransaction(pool, (tx) => enqueue(tx, { workflowId: id, type: "notify.only" }));
    await r.tick();
    expect(seen).toEqual(["quote.requested"]);
    expect((await outboxRows(pool, id)).map((x) => x.status)).toEqual(["done", "done"]);
  });

  it("retries retryable failures with backoff, then dead-letters with a reason", async () => {
    const id = await createTestWorkflow(pool);
    let calls = 0;
    const { relay: r, deadLettered } = relay({
      "quote.requested": () => {
        calls++;
        return Promise.reject(new RetryableError("HTTP 503"));
      },
    });
    for (let i = 0; i < 5; i++) await r.tick();
    expect(calls).toBe(3);
    const [row] = await outboxRows(pool, id);
    expect(row).toMatchObject({ status: "dead", attempts: 3 });
    expect(row?.last_error).toContain("exhausted 3 attempts");
    expect(deadLettered).toEqual([{ workflowId: id, reason: "exhausted 3 attempts: RetryableError: HTTP 503" }]);
  });

  it("schedules the retry in the future according to the backoff", async () => {
    const id = await createTestWorkflow(pool);
    const { relay: r } = relay(
      { "quote.requested": () => Promise.reject(new RetryableError("timeout")) },
      { retry: { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 }, random: () => 0.5 },
    );
    await r.tick();
    const { rows } = await pool.query<{ delay: number }>(
      "SELECT EXTRACT(EPOCH FROM available_at - now())::float8 AS delay FROM outbox WHERE workflow_id = $1",
      [id],
    );
    expect(rows[0]!.delay).toBeGreaterThan(25);
    expect(rows[0]!.delay).toBeLessThanOrEqual(30);
    expect(await r.tick()).toBe(0); // not due yet
  });

  it("dead-letters non-retryable failures on the first attempt", async () => {
    const id = await createTestWorkflow(pool);
    const { relay: r, deadLettered } = relay({
      "quote.requested": () => Promise.reject(new NonRetryableError("card declined")),
    });
    await r.tick();
    expect((await outboxRows(pool, id))[0]).toMatchObject({ status: "dead", attempts: 1 });
    expect(deadLettered[0]?.reason).toBe("non-retryable: NonRetryableError: card declined");
  });

  it("dead-letters an event whose earlier attempts never finished (crash loop guard)", async () => {
    const id = await createTestWorkflow(pool);
    await pool.query("UPDATE outbox SET attempts = 3 WHERE workflow_id = $1", [id]);
    let calls = 0;
    const { relay: r, deadLettered } = relay({
      "quote.requested": () => {
        calls++;
        return Promise.resolve();
      },
    });
    await r.tick();
    expect(calls).toBe(0);
    expect(deadLettered[0]?.reason).toContain("previous attempts did not finish");
  });
});
