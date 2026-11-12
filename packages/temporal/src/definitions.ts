/**
 * Everything the workflow, its clients and its workers must agree on: the
 * workflow's name, input, signal, query and the shape of its state. This file
 * is imported by workflow code, so it must stay free of I/O and Node APIs.
 */
import { defineQuery, defineSignal } from "@temporalio/workflow";
import type { PolicyApplication } from "@policy/domain/pricing";
import type { WorkflowState } from "@policy/domain/stateMachine";
import type { StepName } from "@policy/domain/steps";

export const TASK_QUEUE = "policy-issuance";

/** Retry settings for one activity. Temporal's backoff is exponential without jitter. */
export interface ActivityRetry {
  readonly maxAttempts: number;
  readonly initialIntervalMs: number;
  readonly maxIntervalMs: number;
  readonly backoffCoefficient?: number;
}

export interface PolicyWorkflowConfig {
  /** Per-activity retry policy, keyed by step name. Missing steps use DEFAULT_RETRY. */
  readonly retry?: Partial<Record<StepName, ActivityRetry>>;
  /** Start-to-close timeout for one activity attempt. A worker that dies mid-attempt is detected by this. */
  readonly activityTimeoutMs?: number;
  /**
   * How long a dead-lettered workflow stays open to catch a payment that
   * succeeds after we gave up (so it can be flagged for refund).
   */
  readonly lateCaptureGraceMs?: number;
}

export interface PolicyWorkflowInput {
  readonly application: PolicyApplication;
  readonly correlationId: string;
  readonly config?: PolicyWorkflowConfig;
}

export interface Transition {
  readonly from: WorkflowState | null;
  readonly to: WorkflowState;
  readonly cause: string;
}

/** What the `state` query returns; also the shape of the HTTP API's GET response. */
export interface PolicySnapshot {
  readonly workflowId: string;
  readonly correlationId: string;
  readonly state: WorkflowState;
  readonly premiumCents: number | null;
  readonly paymentChargeId: string | null;
  readonly policyNumber: string | null;
  readonly documentDeliveryId: string | null;
  readonly deadLetterReason: string | null;
  readonly transitions: readonly Transition[];
  /** Payment callbacks that were recognised as repeats and ignored. */
  readonly duplicateSignals: number;
  /** Things an operator should look at (a second distinct charge, a capture after dead-letter, ...). */
  readonly anomalies: readonly string[];
}

export interface PaymentConfirmed {
  /** The provider's event id; repeats of the same event are recognised by it. */
  readonly eventId: string;
  readonly chargeId: string;
}

export const paymentConfirmedSignal = defineSignal<[PaymentConfirmed]>("paymentConfirmed");
export const stateQuery = defineQuery<PolicySnapshot>("state");

/** Error type of the workflow failure raised when a workflow is dead-lettered. */
export const DEAD_LETTERED_ERROR = "PolicyWorkflowDeadLettered";
