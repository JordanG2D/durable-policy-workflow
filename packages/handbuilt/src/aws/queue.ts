import { randomUUID } from "node:crypto";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import type { Pool } from "../db/pool.js";
import type { ClaimedEvent } from "../outbox/outbox.js";
import type { Relay } from "../outbox/relay.js";

export interface QueueTransport {
  send(queueUrl: string, body: string): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseEnvelope(body: string): string {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("kind" in value) || value.kind !== "outbox" || !("eventId" in value) ||
      typeof value.eventId !== "string" || !UUID.test(value.eventId)) {
    throw new Error("invalid outbox envelope");
  }
  return value.eventId;
}

/** Repeated publishing is intentional: no DB/SQS dual-write can lose an event.
 * Publication never consumes an execution attempt or leases a workflow. */
export async function publishDue(pool: Pool, queue: QueueTransport, queueUrl: string, limit = 100): Promise<number> {
  const { rows } = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM outbox WHERE status = 'pending' AND available_at <= now()
     AND (lease_expires_at IS NULL OR lease_expires_at < now()) ORDER BY available_at, id LIMIT $1`, [limit]);
  let sent = 0;
  // Fail fast on transport failure. Already sent rows may be republished safely.
  for (const row of rows) {
    await queue.send(queueUrl, JSON.stringify({ version: 1, kind: "outbox", eventId: row.event_id }));
    sent++;
  }
  return sent;
}

export async function claimEvent(pool: Pool, eventId: string, leaseMs: number): Promise<ClaimedEvent | undefined> {
  const owner = `sqs:${randomUUID()}`;
  const { rows } = await pool.query<ClaimedEvent>(
    `WITH due AS (
       SELECT id FROM outbox WHERE event_id = $1 AND status = 'pending' AND available_at <= now()
       AND (lease_expires_at IS NULL OR lease_expires_at < now()) FOR UPDATE SKIP LOCKED
     ) UPDATE outbox o SET lease_owner = $2, lease_token = gen_random_uuid(),
       lease_expires_at = now() + make_interval(secs => $3::float8 / 1000), attempts = o.attempts + 1
       FROM due WHERE o.id = due.id
       RETURNING o.id, o.event_id AS "eventId", o.workflow_id AS "workflowId", o.type, o.payload,
       o.correlation_id AS "correlationId", o.trace_parent AS "traceParent", o.attempts,
       o.lease_token AS "leaseToken", o.lease_owner AS "leaseOwner"`, [eventId, owner, leaseMs]);
  return rows[0];
}

export function createQueueWorker(deps: {
  claim(eventId: string): Promise<ClaimedEvent | undefined>;
  relay: Pick<Relay, "processClaim">;
}) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    await Promise.all(event.Records.map(async (record) => {
      try {
        const claim = await deps.claim(parseEnvelope(record.body));
        // Done, stale, leased elsewhere, or still in DB backoff. Acknowledge this
        // transport copy; the scheduler is responsible for future due attempts.
        if (claim) await deps.relay.processClaim(claim);
      } catch {
        // Do not log the untrusted body or credentials. Native SQS redrive
        // quarantines malformed/poison records after maxReceiveCount.
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }));
    return { batchItemFailures };
  };
}
