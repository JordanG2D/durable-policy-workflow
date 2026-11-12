import type { Pool, Tx } from "../db/pool.js";
import { ConcurrentStateChangeError } from "../outbox/errors.js";
import {
  IllegalTransitionError,
  assertTransition,
  isWorkflowState,
  type WorkflowState,
} from "@policy/domain/stateMachine";
import type { Logger } from "@policy/domain/logger";
import type { Metrics } from "../observability/metrics.js";
import { traceParentOf } from "@policy/domain/tracing";
import { enqueue } from "../outbox/outbox.js";
import type { PolicyApplication } from "@policy/domain/pricing";

export interface Workflow {
  readonly id: string;
  readonly state: WorkflowState;
  readonly version: number;
  readonly application: PolicyApplication;
  readonly premiumCents: number | null;
  readonly paymentChargeId: string | null;
  readonly policyNumber: string | null;
  readonly documentDeliveryId: string | null;
  readonly deadLetterReason: string | null;
  readonly correlationId: string;
  readonly traceParent: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface WorkflowRow {
  id: string;
  state: string;
  version: number;
  application: PolicyApplication;
  premium_cents: string | null;
  payment_charge_id: string | null;
  policy_number: string | null;
  document_delivery_id: string | null;
  dead_letter_reason: string | null;
  correlation_id: string;
  trace_parent: string | null;
  created_at: Date;
  updated_at: Date;
}

function toWorkflow(r: WorkflowRow): Workflow {
  if (!isWorkflowState(r.state)) throw new Error(`unknown state in database: ${r.state}`);
  return {
    id: r.id,
    state: r.state,
    version: r.version,
    application: r.application,
    premiumCents: r.premium_cents === null ? null : Number(r.premium_cents),
    paymentChargeId: r.payment_charge_id,
    policyNumber: r.policy_number,
    documentDeliveryId: r.document_delivery_id,
    deadLetterReason: r.dead_letter_reason,
    correlationId: r.correlation_id,
    traceParent: r.trace_parent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type Db = Pool | Tx;

export async function getWorkflow(db: Db, id: string): Promise<Workflow | undefined> {
  const { rows } = await db.query<WorkflowRow>("SELECT * FROM workflows WHERE id = $1", [id]);
  return rows[0] && toWorkflow(rows[0]);
}

/** Row-lock the workflow for the rest of the transaction. */
export async function lockWorkflow(tx: Tx, id: string): Promise<Workflow> {
  const { rows } = await tx.query<WorkflowRow>("SELECT * FROM workflows WHERE id = $1 FOR UPDATE", [
    id,
  ]);
  if (!rows[0]) throw new Error(`workflow ${id} not found`);
  return toWorkflow(rows[0]);
}

export async function listTransitions(
  db: Db,
  workflowId: string,
): Promise<{ from: string | null; to: string; cause: string; at: Date }[]> {
  const { rows } = await db.query<{
    from_state: string | null;
    to_state: string;
    cause: string;
    created_at: Date;
  }>(
    `SELECT from_state, to_state, cause, created_at FROM workflow_transitions
      WHERE workflow_id = $1 ORDER BY id`,
    [workflowId],
  );
  return rows.map((r) => ({ from: r.from_state, to: r.to_state, cause: r.cause, at: r.created_at }));
}

/** Creates the workflow, its first audit row and its first outbox event, atomically. */
export async function insertWorkflow(
  tx: Tx,
  input: {
    id: string;
    application: PolicyApplication;
    correlationId: string;
    traceParent: string | undefined;
  },
): Promise<Workflow> {
  const { rows } = await tx.query<WorkflowRow>(
    `INSERT INTO workflows (id, state, application, correlation_id, trace_parent)
     VALUES ($1, 'QUOTE_REQUESTED', $2, $3, $4) RETURNING *`,
    [input.id, JSON.stringify(input.application), input.correlationId, input.traceParent ?? null],
  );
  await tx.query(
    `INSERT INTO workflow_transitions (workflow_id, from_state, to_state, cause)
     VALUES ($1, NULL, 'QUOTE_REQUESTED', 'api')`,
    [input.id],
  );
  await enqueue(tx, {
    workflowId: input.id,
    type: "quote.requested",
    correlationId: input.correlationId,
    traceParent: input.traceParent,
  });
  return toWorkflow(rows[0]!);
}

export interface WorkflowPatch {
  premiumCents?: number;
  paymentChargeId?: string;
  policyNumber?: string;
  documentDeliveryId?: string;
  deadLetterReason?: string;
}

const PATCH_COLUMNS: Record<keyof WorkflowPatch, string> = {
  premiumCents: "premium_cents",
  paymentChargeId: "payment_charge_id",
  policyNumber: "policy_number",
  documentDeliveryId: "document_delivery_id",
  deadLetterReason: "dead_letter_reason",
};

export interface TransitionDeps {
  readonly log: Logger;
  readonly metrics: Metrics;
}

/**
 * The only way a workflow changes state after creation. In one transaction it:
 * validates the transition against the state machine, updates the row with an
 * optimistic version check, appends to the audit trail, and writes the outbox
 * event announcing the change. Illegal transitions are logged, counted and
 * rejected before anything is written.
 */
export async function transition(
  tx: Tx,
  deps: TransitionDeps,
  args: {
    workflow: Workflow;
    to: WorkflowState;
    cause: string;
    patch?: WorkflowPatch;
    event?: { type: string; payload?: Record<string, unknown> };
  },
): Promise<Workflow> {
  const { workflow, to } = args;
  try {
    assertTransition(workflow.state, to);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      deps.metrics.illegalTransitions.inc({ from: err.from, to: err.to });
      deps.log.warn(
        { workflowId: workflow.id, correlationId: workflow.correlationId, from: err.from, to: err.to, cause: args.cause },
        "illegal transition rejected",
      );
    }
    throw err;
  }

  const sets = ["state = $3", "version = version + 1", "updated_at = now()"];
  const params: unknown[] = [workflow.id, workflow.version, to];
  for (const [key, value] of Object.entries(args.patch ?? {})) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${PATCH_COLUMNS[key as keyof WorkflowPatch]} = $${params.length}`);
  }
  const { rows } = await tx.query<WorkflowRow>(
    `UPDATE workflows SET ${sets.join(", ")} WHERE id = $1 AND version = $2 RETURNING *`,
    params,
  );
  if (!rows[0]) {
    throw new ConcurrentStateChangeError(`workflow ${workflow.id} changed concurrently`);
  }
  await tx.query(
    `INSERT INTO workflow_transitions (workflow_id, from_state, to_state, cause)
     VALUES ($1, $2, $3, $4)`,
    [workflow.id, workflow.state, to, args.cause],
  );
  if (args.event) {
    await enqueue(tx, {
      workflowId: workflow.id,
      type: args.event.type,
      ...(args.event.payload ? { payload: args.event.payload } : {}),
      correlationId: workflow.correlationId,
      traceParent: traceParentOf() ?? workflow.traceParent,
    });
  }
  deps.log.info(
    { workflowId: workflow.id, correlationId: workflow.correlationId, from: workflow.state, to, cause: args.cause },
    "workflow transitioned",
  );
  return toWorkflow(rows[0]);
}
