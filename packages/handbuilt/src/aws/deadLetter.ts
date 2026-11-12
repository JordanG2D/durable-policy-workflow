import { withTransaction, type Pool } from "../db/pool.js";
import { completeWithFence, type ClaimedEvent } from "../outbox/outbox.js";
import type { QueueTransport } from "./queue.js";

/** Durable at-least-once mirror: acknowledgement follows send, never precedes
 * it. A crash between the two can duplicate this stable eventId, but cannot
 * lose the notice. Transport failures leave the lease to expire for retry. */
export async function mirrorDeadLetter(pool: Pool, queue: QueueTransport, dlqUrl: string, claim: ClaimedEvent) {
  await queue.send(dlqUrl, JSON.stringify({ version: 1, kind: "workflow.dead_lettered",
    eventId: claim.eventId, workflowId: claim.workflowId, correlationId: claim.correlationId,
    payload: claim.payload }));
  await withTransaction(pool, (tx) => completeWithFence(tx, claim));
}
