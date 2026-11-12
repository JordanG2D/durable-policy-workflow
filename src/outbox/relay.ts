import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { SpanStatusCode } from "@opentelemetry/api";
import { withTransaction, type Pool, type Tx } from "../db/pool.js";
import { LeaseLostError, errorMessage, isRetryable } from "../domain/errors.js";
import { decideRetry, type RetryPolicy } from "../domain/retryPolicy.js";
import { noCrash, type CrashHook } from "../faults/crash.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { contextFromTraceParent, tracer } from "../observability/tracing.js";
import {
  claimBatch,
  completeWithFence,
  markDead,
  scheduleRetry,
  type ClaimedEvent,
} from "./outbox.js";

export interface StepContext {
  readonly claim: ClaimedEvent;
  readonly log: Logger;
  /**
   * Apply the step's database effects atomically with completing this outbox
   * event. The lease fence runs first in the same transaction, so a worker
   * that lost its lease cannot commit anything.
   */
  commit(fn: (tx: Tx) => Promise<void>): Promise<void>;
}

export type StepHandler = (ctx: StepContext) => Promise<void>;

export interface RelayOptions {
  readonly pool: Pool;
  readonly handlers: Readonly<Record<string, StepHandler>>;
  /** Called inside the transaction that marks an event dead. */
  readonly onDeadLetter: (tx: Tx, claim: ClaimedEvent, reason: string) => Promise<void>;
  readonly retry: RetryPolicy;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly owner?: string;
  readonly crash?: CrashHook;
  readonly random?: () => number;
}

/**
 * Polls the outbox and runs the step for each due event.
 *
 * Delivery is at-least-once: a crash or a lost lease means an event can be
 * processed again. Steps are written so a repeat is harmless (state checks,
 * idempotency keys on external calls, unique constraints), which together
 * give exactly-once *effects*.
 */
export class Relay {
  readonly owner: string;
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly crash: CrashHook;

  constructor(private readonly opts: RelayOptions) {
    this.owner = opts.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.crash = opts.crash ?? noCrash;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (err) {
        this.opts.logger.error({ err, owner: this.owner }, "relay tick failed");
      }
      if (claimed === 0 && this.running) await sleep(this.opts.pollIntervalMs);
    }
  }

  /** Claim one batch and process it. Returns the number of events claimed. */
  async tick(): Promise<number> {
    const claims = await claimBatch(this.opts.pool, this.owner, this.opts.batchSize, this.opts.leaseMs);
    // Each workflow has at most one pending step event at a time, so events in a
    // batch belong to different workflows and can run concurrently.
    await Promise.all(claims.map((c) => this.process(c)));
    return claims.length;
  }

  private async process(claim: ClaimedEvent): Promise<void> {
    const { metrics, pool } = this.opts;
    const log = this.opts.logger.child({
      workflowId: claim.workflowId,
      correlationId: claim.correlationId,
      eventId: claim.eventId,
      event: claim.type,
      attempt: claim.attempts,
      owner: this.owner,
    });
    const startedAt = performance.now();
    let outcome = "ok";

    await tracer().startActiveSpan(
      `step ${claim.type}`,
      {
        attributes: {
          "workflow.id": claim.workflowId,
          "outbox.event_id": claim.eventId,
          "outbox.attempt": claim.attempts,
        },
      },
      contextFromTraceParent(claim.traceParent),
      async (span) => {
        try {
          this.crash(`after-claim:${claim.type}`);

          // A step that kills its worker every time never reaches the normal
          // failure path, so the attempt budget is also enforced at claim time.
          if (claim.attempts > this.opts.retry.maxAttempts) {
            throw new AttemptsExhaustedError(
              `attempt ${claim.attempts} exceeds limit ${this.opts.retry.maxAttempts} (previous attempts did not finish)`,
            );
          }

          let committed = false;
          const ctx: StepContext = {
            claim,
            log,
            commit: async (fn) => {
              await withTransaction(pool, async (tx) => {
                await completeWithFence(tx, claim);
                await fn(tx);
              });
              committed = true;
              this.crash(`after-commit:${claim.type}`);
            },
          };

          const handler = this.opts.handlers[claim.type];
          if (handler) await handler(ctx);
          // No handler (a notification-only event) or a no-op step: just acknowledge.
          if (!committed) await withTransaction(pool, (tx) => completeWithFence(tx, claim));
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
          outcome = await this.handleFailure(claim, err, log);
        } finally {
          span.setAttribute("step.outcome", outcome);
          span.end();
          metrics.stepDuration.observe(
            { step: claim.type, outcome },
            (performance.now() - startedAt) / 1000,
          );
        }
      },
    );
  }

  private async handleFailure(claim: ClaimedEvent, err: unknown, log: Logger): Promise<string> {
    const { metrics, pool } = this.opts;
    if (err instanceof LeaseLostError) {
      metrics.leaseLost.inc();
      log.warn({ err }, "lease lost; discarding step result, the new lease owner will finish it");
      return "lease_lost";
    }
    const message = errorMessage(err);
    const decision =
      err instanceof AttemptsExhaustedError
        ? ({ kind: "dead-letter", reason: message } as const)
        : decideRetry(
            this.opts.retry,
            claim.attempts,
            { message, retryable: isRetryable(err) },
            this.opts.random,
          );
    try {
      if (decision.kind === "retry") {
        await withTransaction(pool, (tx) => scheduleRetry(tx, claim, decision.delayMs, message));
        metrics.stepRetries.inc({ step: claim.type });
        log.warn({ err: message, delayMs: decision.delayMs }, "step failed; retry scheduled");
        return "retry";
      }
      await withTransaction(pool, async (tx) => {
        await markDead(tx, claim, decision.reason);
        await this.opts.onDeadLetter(tx, claim, decision.reason);
      });
      log.error({ reason: decision.reason }, "step dead-lettered");
      return "dead_letter";
    } catch (inner) {
      if (inner instanceof LeaseLostError) {
        metrics.leaseLost.inc();
        log.warn("lease lost while recording failure; the new lease owner will handle it");
        return "lease_lost";
      }
      // Leave the lease to expire; the event will be reclaimed and retried.
      log.error({ err: inner }, "could not record step failure");
      return "error";
    }
  }
}

class AttemptsExhaustedError extends Error {
  override readonly name = "AttemptsExhaustedError";
}
