import type { WorkflowState } from "./stateMachine.js";

/**
 * The workflow's steps, named after the hand-built outbox event that triggers
 * each one. Both implementations use these names in failure reasons
 * ("policy.bound failed: ..."), in span names ("step policy.bound") and in
 * crash points ("after-side-effect:policy.bound"), so their traces, logs and
 * dead-letter reasons can be compared line for line.
 */
export const Steps = {
  /** QUOTE_REQUESTED -> QUOTE_PRICED: run the pricing rule. */
  price: "quote.requested",
  /** QUOTE_PRICED -> POLICY_BOUND: bind the priced quote (no side effect). */
  bind: "quote.priced",
  /** POLICY_BOUND -> PAYMENT_CONFIRMED: charge the card. */
  charge: "policy.bound",
  /** PAYMENT_CONFIRMED -> POLICY_ISSUED: assign the policy number. */
  issue: "payment.confirmed",
  /** POLICY_ISSUED -> DOCUMENTS_DELIVERED: render and deliver documents. */
  deliver: "policy.issued",
} as const;

export type StepName = (typeof Steps)[keyof typeof Steps];

/** The state a workflow must be in for each step to run. */
export const STEP_FROM_STATE: Readonly<Record<StepName, WorkflowState>> = {
  "quote.requested": "QUOTE_REQUESTED",
  "quote.priced": "QUOTE_PRICED",
  "policy.bound": "POLICY_BOUND",
  "payment.confirmed": "PAYMENT_CONFIRMED",
  "policy.issued": "POLICY_ISSUED",
};

export const stepSpanName = (step: StepName) => `step ${step}`;

/** Name of the root span that starts each workflow's trace, in both implementations. */
export const WORKFLOW_SPAN_NAME = "workflow policy-issuance";
