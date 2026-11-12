import type { DocumentGateway, PaymentGateway } from "../clients/gateways.js";
import type { Pool, Tx } from "../db/pool.js";
import { NonRetryableError } from "../domain/errors.js";
import type { PricingEngine } from "../domain/pricing.js";
import { isTerminal, progressOf, type WorkflowState } from "../domain/stateMachine.js";
import { noCrash, type CrashHook } from "../faults/crash.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { ClaimedEvent } from "../outbox/outbox.js";
import type { StepContext, StepHandler } from "../outbox/relay.js";
import { getWorkflow, lockWorkflow, transition, type Workflow } from "./repository.js";

/**
 * The workflow, step by step. Each outbox event names the step that should run
 * next. Every step follows the same shape:
 *
 *   1. Read the workflow. If it is no longer in the state this event expects,
 *      the event is a duplicate or was overtaken (e.g. a payment callback beat
 *      the charge response): acknowledge it and do nothing.
 *   2. Perform the external side effect, if any, with an idempotency key that
 *      is derived from the workflow id, so a repeat of this step after a crash,
 *      timeout or lost lease is recognised by the remote service.
 *   3. In one transaction: fence on the outbox lease, re-lock the workflow,
 *      re-check its state, transition, and enqueue the next event.
 */

export interface WorkflowDeps {
  readonly pool: Pool;
  readonly log: Logger;
  readonly metrics: Metrics;
  readonly pricing: PricingEngine;
  readonly payments: PaymentGateway;
  readonly documents: DocumentGateway;
  readonly paymentCallbackUrl: string;
  readonly crash?: CrashHook;
}

export const paymentIdempotencyKey = (workflowId: string) => `charge:${workflowId}`;
export const documentIdempotencyKey = (workflowId: string) => `documents:${workflowId}`;

export function createStepHandlers(deps: WorkflowDeps): Record<string, StepHandler> {
  const crash = deps.crash ?? noCrash;

  /** Wraps a step with the "is this event still current?" check. */
  const step =
    (expected: WorkflowState, run: (wf: Workflow, ctx: StepContext) => Promise<void>): StepHandler =>
    async (ctx) => {
      const wf = await getWorkflow(deps.pool, ctx.claim.workflowId);
      if (!wf) throw new NonRetryableError(`workflow ${ctx.claim.workflowId} not found`);
      if (wf.state !== expected) {
        deps.metrics.duplicatesSuppressed.inc({ kind: "event" });
        ctx.log.info(
          { correlationId: wf.correlationId, state: wf.state, expected },
          "event no longer current; acknowledging without side effects",
        );
        return;
      }
      await run(wf, ctx);
    };

  /** Commit a transition only if the workflow is still in `expected` once locked. */
  const commitTransition = (
    ctx: StepContext,
    expected: WorkflowState,
    build: (wf: Workflow, tx: Tx) => Promise<Parameters<typeof transition>[2]>,
  ): Promise<boolean> => {
    let applied = false;
    return ctx
      .commit(async (tx) => {
        const wf = await lockWorkflow(tx, ctx.claim.workflowId);
        if (wf.state !== expected) {
          deps.metrics.duplicatesSuppressed.inc({ kind: "event" });
          ctx.log.info({ state: wf.state, expected }, "workflow moved on concurrently; not re-applying");
          return;
        }
        await transition(tx, deps, await build(wf, tx));
        applied = true;
      })
      .then(() => applied);
  };

  return {
    "quote.requested": step("QUOTE_REQUESTED", async (wf, ctx) => {
      const premiumCents = await deps.pricing.price(wf.application);
      await commitTransition(ctx, "QUOTE_REQUESTED", async (locked) => ({
        workflow: locked,
        to: "QUOTE_PRICED",
        cause: "priced",
        patch: { premiumCents },
        event: { type: "quote.priced", payload: { premiumCents } },
      }));
    }),

    // Binding is automatic in this demo: a priced quote within appetite is bound.
    "quote.priced": step("QUOTE_PRICED", async (_wf, ctx) => {
      await commitTransition(ctx, "QUOTE_PRICED", async (locked) => ({
        workflow: locked,
        to: "POLICY_BOUND",
        cause: "auto-bind",
        event: { type: "policy.bound" },
      }));
    }),

    "policy.bound": step("POLICY_BOUND", async (wf, ctx) => {
      if (wf.premiumCents === null) throw new NonRetryableError("bound workflow has no premium");
      const { chargeId } = await deps.payments.charge({
        idempotencyKey: paymentIdempotencyKey(wf.id),
        reference: wf.id,
        amountCents: wf.premiumCents,
        callbackUrl: deps.paymentCallbackUrl,
      });
      crash("after-side-effect:policy.bound");
      await ctx.commit(async (tx) => {
        await confirmPayment(tx, { ...deps, log: ctx.log }, { workflowId: wf.id, chargeId, cause: "charge-response" });
      });
    }),

    "payment.confirmed": step("PAYMENT_CONFIRMED", async (_wf, ctx) => {
      await commitTransition(ctx, "PAYMENT_CONFIRMED", async (locked, tx) => {
        // The sequence value is taken inside the transaction that issues the
        // policy, and policy_number is UNIQUE, so a policy is numbered once.
        const { rows } = await tx.query<{ n: string }>("SELECT nextval('policy_number_seq') AS n");
        const policyNumber = `GL-${locked.createdAt.getUTCFullYear()}-${rows[0]!.n}`;
        return {
          workflow: locked,
          to: "POLICY_ISSUED",
          cause: "issued",
          patch: { policyNumber },
          event: { type: "policy.issued", payload: { policyNumber } },
        };
      });
    }),

    "policy.issued": step("POLICY_ISSUED", async (wf, ctx) => {
      if (!wf.policyNumber) throw new NonRetryableError("issued workflow has no policy number");
      const { deliveryId } = await deps.documents.deliver({
        idempotencyKey: documentIdempotencyKey(wf.id),
        policyNumber: wf.policyNumber,
        recipient: wf.application.contactEmail,
      });
      crash("after-side-effect:policy.issued");
      const applied = await commitTransition(ctx, "POLICY_ISSUED", async (locked) => ({
        workflow: locked,
        to: "DOCUMENTS_DELIVERED",
        cause: "documents-delivered",
        patch: { documentDeliveryId: deliveryId },
        event: { type: "workflow.completed" },
      }));
      if (applied) deps.metrics.workflowsCompleted.inc();
    }),
  };
}

export type PaymentConfirmationOutcome =
  | "confirmed"
  | "already-confirmed"
  | "captured-after-dead-letter"
  | "not-awaiting-payment";

/**
 * Single code path for "the provider says the charge succeeded", used by both
 * the synchronous charge response and the asynchronous callback. Whichever
 * arrives first moves the workflow on; the other finds it already confirmed.
 * The row lock serialises the two.
 */
export async function confirmPayment(
  tx: Tx,
  deps: Pick<WorkflowDeps, "log" | "metrics">,
  args: { workflowId: string; chargeId: string; cause: string },
): Promise<PaymentConfirmationOutcome> {
  const wf = await lockWorkflow(tx, args.workflowId);
  const log = deps.log.child({ workflowId: wf.id, correlationId: wf.correlationId, chargeId: args.chargeId });

  if (wf.state === "POLICY_BOUND") {
    await transition(tx, { log, metrics: deps.metrics }, {
      workflow: wf,
      to: "PAYMENT_CONFIRMED",
      cause: args.cause,
      patch: { paymentChargeId: args.chargeId },
      event: { type: "payment.confirmed", payload: { chargeId: args.chargeId } },
    });
    return "confirmed";
  }
  if (wf.state === "DEAD_LETTERED") {
    // Money moved after we gave up on the workflow. Do not resurrect it
    // silently; flag it loudly for an operator to refund or reinstate.
    deps.metrics.capturedAfterDeadLetter.inc();
    await tx.query(
      `UPDATE workflows SET dead_letter_reason = COALESCE(dead_letter_reason, '') || $2, updated_at = now() WHERE id = $1`,
      [wf.id, ` | payment ${args.chargeId} captured after dead-letter: manual refund required`],
    );
    log.error("payment captured after workflow was dead-lettered; manual refund required");
    return "captured-after-dead-letter";
  }
  if (progressOf(wf.state) > progressOf("POLICY_BOUND")) {
    deps.metrics.duplicatesSuppressed.inc({ kind: "payment-confirmation" });
    if (wf.paymentChargeId !== args.chargeId) {
      log.error({ recordedChargeId: wf.paymentChargeId }, "second distinct charge reported for one workflow");
    } else {
      log.info({ cause: args.cause }, "payment already confirmed; ignoring duplicate confirmation");
    }
    return "already-confirmed";
  }
  log.warn({ state: wf.state }, "payment confirmation for a workflow that has not requested payment");
  return "not-awaiting-payment";
}

/** Relay hook: move the workflow to DEAD_LETTERED in the same transaction that kills the event. */
export function createDeadLetterHandler(deps: Pick<WorkflowDeps, "log" | "metrics">) {
  return async (tx: Tx, claim: ClaimedEvent, reason: string): Promise<void> => {
    const wf = await lockWorkflow(tx, claim.workflowId);
    if (isTerminal(wf.state)) return;
    await transition(tx, deps, {
      workflow: wf,
      to: "DEAD_LETTERED",
      cause: `dead-letter:${claim.type}`,
      patch: { deadLetterReason: `${claim.type} failed: ${reason}` },
      event: { type: "workflow.dead_lettered", payload: { failedStep: claim.type, reason } },
    });
    deps.metrics.workflowsFailed.inc({ step: claim.type });
  };
}
