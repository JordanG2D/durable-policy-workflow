import { LeaseLostError } from "./errors.js";
import type { Pool, Tx } from "../db/pool.js";

export interface OutboxEvent {
  readonly workflowId: string;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly correlationId?: string | undefined;
  readonly traceParent?: string | null | undefined;
}

export interface ClaimedEvent {
  readonly id: string;
  readonly eventId: string;
  readonly workflowId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly traceParent: string | null;
  /** Attempts including the one this claim starts. */
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseOwner: string;
}

/**
 * Write an event in the caller's transaction. This is the "transactional" in
 * transactional outbox: callers always do this in the same transaction as the
 * state change the event describes, so either both exist or neither does.
 */
export async function enqueue(tx: Tx, event: OutboxEvent): Promise<string> {
  const { rows } = await tx.query<{ event_id: string }>(
    `INSERT INTO outbox (workflow_id, type, payload, correlation_id, trace_parent)
     VALUES ($1, $2, $3, $4, $5) RETURNING event_id`,
    [
      event.workflowId,
      event.type,
      JSON.stringify(event.payload ?? {}),
      event.correlationId ?? null,
      event.traceParent ?? null,
    ],
  );
  return rows[0]!.event_id;
}

/**
 * Claim up to `limit` due events for `owner`.
 *
 * `FOR UPDATE SKIP LOCKED` lets many relays poll concurrently without blocking
 * each other or claiming the same row. The claim itself is a lease: it is
 * stamped with a fresh token and an expiry, and committed immediately so the
 * row lock is not held while the step runs. If the owner dies, the lease
 * expires and another relay reclaims the row. The attempt counter is bumped
 * at claim time, so a step that crashes its worker every time still runs out
 * of attempts and is dead-lettered instead of looping forever.
 */
export async function claimBatch(
  pool: Pool,
  owner: string,
  limit: number,
  leaseMs: number,
): Promise<ClaimedEvent[]> {
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    workflow_id: string;
    type: string;
    payload: Record<string, unknown>;
    correlation_id: string | null;
    trace_parent: string | null;
    attempts: number;
    lease_token: string;
    lease_owner: string;
  }>(
    `WITH due AS (
       SELECT id FROM outbox
        WHERE status = 'pending'
          AND available_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY available_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox o
        SET lease_owner = $2,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $3::float8 / 1000),
            attempts = o.attempts + 1
       FROM due
      WHERE o.id = due.id
     RETURNING o.id, o.event_id, o.workflow_id, o.type, o.payload, o.correlation_id, o.trace_parent,
               o.attempts, o.lease_token, o.lease_owner`,
    [limit, owner, leaseMs],
  );
  return rows
    .map((r) => ({
      id: r.id,
      eventId: r.event_id,
      workflowId: r.workflow_id,
      type: r.type,
      payload: r.payload,
      correlationId: r.correlation_id,
      traceParent: r.trace_parent,
      attempts: r.attempts,
      leaseToken: r.lease_token,
      leaseOwner: r.lease_owner,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Mark the event done, but only if this claim still holds the lease. Called
 * first inside the step's commit transaction: it locks the outbox row (so a
 * reclaiming relay skips it) and acts as a fencing token. If the lease was
 * lost, it throws and the whole transaction, including the state change,
 * rolls back.
 */
export async function completeWithFence(tx: Tx, claim: ClaimedEvent): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE outbox
        SET status = 'done', processed_at = now(), lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'pending'`,
    [claim.id, claim.leaseToken],
  );
  if (rowCount !== 1) throw new LeaseLostError(`lease lost on outbox event ${claim.id}`);
}

/** Release the lease and make the event due again after `delayMs`. */
export async function scheduleRetry(
  tx: Tx,
  claim: ClaimedEvent,
  delayMs: number,
  error: string,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE outbox
        SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            available_at = now() + make_interval(secs => $3::float8 / 1000),
            last_error = $4
      WHERE id = $1 AND lease_token = $2 AND status = 'pending'`,
    [claim.id, claim.leaseToken, delayMs, error],
  );
  if (rowCount !== 1) throw new LeaseLostError(`lease lost on outbox event ${claim.id}`);
}

export async function markDead(tx: Tx, claim: ClaimedEvent, error: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE outbox
        SET status = 'dead', processed_at = now(), lease_expires_at = NULL, last_error = $3
      WHERE id = $1 AND lease_token = $2 AND status = 'pending'`,
    [claim.id, claim.leaseToken, error],
  );
  if (rowCount !== 1) throw new LeaseLostError(`lease lost on outbox event ${claim.id}`);
}
