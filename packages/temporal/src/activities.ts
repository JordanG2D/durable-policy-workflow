/**
 * Activities: every side effect of the workflow, run by workers outside the
 * workflow sandbox. Temporal delivers each activity at least once (a retry
 * after a timeout, or after the worker died, re-runs it), so each one passes
 * an idempotency key derived from the workflow id to the provider. These are
 * the same keys and HTTP clients the hand-built implementation uses.
 */
import { Context } from "@temporalio/activity";
import type { DocumentGateway, PaymentGateway, PolicyGateway } from "@policy/domain/clients/gateways";
import { noCrash, type CrashHook } from "@policy/domain/crash";
import { documentIdempotencyKey, paymentIdempotencyKey, policyIdempotencyKey } from "@policy/domain/idempotency";
import type { PolicyApplication, PricingEngine } from "@policy/domain/pricing";
import { Steps, stepSpanName, type StepName } from "@policy/domain/steps";
import { inSpan } from "@policy/domain/tracing";

export interface ActivityDeps {
  readonly pricing: PricingEngine;
  readonly payments: PaymentGateway;
  readonly policies: PolicyGateway;
  readonly documents: DocumentGateway;
  /** Where the payment provider sends its asynchronous charge.succeeded callback (the API's webhook). */
  readonly paymentCallbackUrl: string;
  readonly crash?: CrashHook;
}

export function createActivities(deps: ActivityDeps) {
  const crash = deps.crash ?? noCrash;

  /** Same span name and attributes as the hand-built relay's `step <event>` span. */
  const step = <T>(name: StepName, workflowId: string, fn: () => Promise<T>): Promise<T> =>
    inSpan(stepSpanName(name), { "workflow.id": workflowId, "activity.attempt": Context.current().info.attempt }, fn);

  return {
    async priceQuote(input: { workflowId: string; application: PolicyApplication }): Promise<number> {
      return step(Steps.price, input.workflowId, () => deps.pricing.price(input.application));
    },

    async chargePayment(input: { workflowId: string; amountCents: number }): Promise<{ chargeId: string }> {
      // The workflow cancels this activity when the provider's callback confirms
      // the payment first. Cancellation reaches an activity only through its
      // heartbeats, so heartbeat while the call is in flight and abort the HTTP
      // call when cancelled. (The charge itself cannot be recalled; the
      // idempotency key makes any later repeat a replay.)
      const ctx = Context.current();
      ctx.heartbeat();
      const beat = setInterval(() => ctx.heartbeat(), 50);
      try {
        return await step(Steps.charge, input.workflowId, async () => {
          const { chargeId } = await deps.payments.charge(
            {
              idempotencyKey: paymentIdempotencyKey(input.workflowId),
              reference: input.workflowId,
              amountCents: input.amountCents,
              callbackUrl: deps.paymentCallbackUrl,
            },
            { signal: ctx.cancellationSignal },
          );
          crash(`after-side-effect:${Steps.charge}`);
          return { chargeId };
        });
      } finally {
        clearInterval(beat);
      }
    },

    async issuePolicy(input: { workflowId: string; premiumCents: number }): Promise<{ policyNumber: string }> {
      return step(Steps.issue, input.workflowId, async () => {
        const { policyNumber } = await deps.policies.issue({
          idempotencyKey: policyIdempotencyKey(input.workflowId),
          reference: input.workflowId,
          premiumCents: input.premiumCents,
        });
        crash(`after-side-effect:${Steps.issue}`);
        return { policyNumber };
      });
    },

    async deliverDocuments(input: {
      workflowId: string;
      policyNumber: string;
      recipient: string;
    }): Promise<{ deliveryId: string }> {
      return step(Steps.deliver, input.workflowId, async () => {
        const { deliveryId } = await deps.documents.deliver({
          idempotencyKey: documentIdempotencyKey(input.workflowId),
          policyNumber: input.policyNumber,
          recipient: input.recipient,
        });
        crash(`after-side-effect:${Steps.deliver}`);
        return { deliveryId };
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
