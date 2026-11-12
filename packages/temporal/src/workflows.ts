/**
 * The policy-issuance workflow on Temporal.
 *
 * This file runs inside Temporal's deterministic workflow sandbox and is
 * replayed from history whenever a worker needs to rebuild its state (after a
 * crash, a deploy, or cache eviction). Therefore: no Date.now, Math.random,
 * timers other than `sleep`/`condition`, network or file I/O, or Node APIs
 * here. Every side effect is an activity. ESLint enforces this
 * (eslint.config.js), and test/replay.test.ts replays recorded histories
 * against this code to catch non-deterministic changes.
 */
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  TimeoutFailure,
  condition,
  log,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
  type ActivityOptions,
} from "@temporalio/workflow";
import { assertTransition, progressOf, type WorkflowState } from "@policy/domain/stateMachine";
import { Steps } from "@policy/domain/steps";
import type { Activities } from "./activities.js";
import {
  DEAD_LETTERED_ERROR,
  paymentConfirmedSignal,
  stateQuery,
  type ActivityRetry,
  type PolicySnapshot,
  type PolicyWorkflowInput,
  type Transition,
} from "./definitions.js";

/** Per-activity defaults. Each can be overridden through the workflow input. */
export const DEFAULT_RETRY: Readonly<Record<ActivityStep, ActivityRetry>> = {
  // In-process rule; failures are rare and short.
  [Steps.price]: { maxAttempts: 5, initialIntervalMs: 200, maxIntervalMs: 5_000 },
  // Card processor: ride out blips and deploys, then hand over to a human.
  [Steps.charge]: { maxAttempts: 6, initialIntervalMs: 500, maxIntervalMs: 30_000 },
  [Steps.issue]: { maxAttempts: 6, initialIntervalMs: 500, maxIntervalMs: 30_000 },
  // Documents can wait longer: the policy is already in force.
  [Steps.deliver]: { maxAttempts: 8, initialIntervalMs: 1_000, maxIntervalMs: 60_000 },
};

/** Error types (the thrown error's `name`) that are never retried. */
export const NON_RETRYABLE_ERROR_TYPES = ["NonRetryableError", "IllegalTransitionError"];

const DEFAULT_ACTIVITY_TIMEOUT_MS = 10_000;
const DEFAULT_LATE_CAPTURE_GRACE_MS = 24 * 60 * 60 * 1_000;

type ActivityStep = typeof Steps.price | typeof Steps.charge | typeof Steps.issue | typeof Steps.deliver;

export async function policyIssuance(input: PolicyWorkflowInput): Promise<PolicySnapshot> {
  const { workflowId } = workflowInfo();
  const config = input.config ?? {};
  const retryFor = (step: ActivityStep): ActivityRetry => config.retry?.[step] ?? DEFAULT_RETRY[step];

  const activitiesFor = (step: ActivityStep, extra: Partial<ActivityOptions> = {}): Activities => {
    const r = retryFor(step);
    const options: ActivityOptions = {
      ...extra,
      startToCloseTimeout: config.activityTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS,
      retry: {
        maximumAttempts: r.maxAttempts,
        initialInterval: r.initialIntervalMs,
        maximumInterval: r.maxIntervalMs,
        backoffCoefficient: r.backoffCoefficient ?? 2,
        nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
      },
    };
    return proxyActivities<Activities>(options);
  };

  // ---- State: the same states and legal transitions as the hand-built version. ----
  let state: WorkflowState = "QUOTE_REQUESTED";
  const transitions: Transition[] = [{ from: null, to: "QUOTE_REQUESTED", cause: "api" }];
  let premiumCents: number | null = null;
  let paymentChargeId: string | null = null;
  let policyNumber: string | null = null;
  let documentDeliveryId: string | null = null;
  let deadLetterReason: string | null = null;
  let duplicateSignals = 0;
  const anomalies: string[] = [];

  const move = (to: WorkflowState, cause: string) => {
    assertTransition(state, to);
    transitions.push({ from: state, to, cause });
    state = to;
    log.info("transition", { workflowId, correlationId: input.correlationId, to, cause });
  };

  const snapshot = (): PolicySnapshot => ({
    workflowId,
    correlationId: input.correlationId,
    state,
    premiumCents,
    paymentChargeId,
    policyNumber,
    documentDeliveryId,
    deadLetterReason,
    transitions: [...transitions],
    duplicateSignals,
    anomalies: [...anomalies],
  });

  const flag = (message: string) => {
    anomalies.push(message);
    log.error(message, { workflowId, correlationId: input.correlationId });
  };

  setHandler(stateQuery, snapshot);

  // ---- Payment confirmation signal: may arrive early, late, or more than once. ----
  const seenEvents = new Set<string>();
  let callbackConfirmation: string | undefined;

  setHandler(paymentConfirmedSignal, ({ eventId, chargeId }) => {
    if (seenEvents.has(eventId)) {
      duplicateSignals++;
      log.info("duplicate payment callback ignored", { workflowId, eventId });
      return;
    }
    seenEvents.add(eventId);

    if (state === "POLICY_BOUND") {
      callbackConfirmation ??= chargeId;
      return;
    }
    if (state === "DEAD_LETTERED") {
      // Money moved after we gave up. Do not resurrect the workflow; flag it.
      deadLetterReason = `${deadLetterReason ?? ""} | payment ${chargeId} captured after dead-letter: manual refund required`;
      flag(`payment ${chargeId} captured after dead-letter: manual refund required`);
      return;
    }
    if (progressOf(state) > progressOf("POLICY_BOUND")) {
      if (chargeId === paymentChargeId) {
        duplicateSignals++;
        log.info("payment already confirmed; ignoring duplicate confirmation", { workflowId, chargeId });
      } else {
        flag(`second distinct charge ${chargeId} reported (recorded ${paymentChargeId})`);
      }
      return;
    }
    flag(`payment confirmation ${chargeId} for a workflow that has not requested payment (state ${state})`);
  });

  /** Settles once no charge attempt is outstanding (see the payment step). */
  let chargeSettled: Promise<unknown> = Promise.resolve();

  /** End in DEAD_LETTERED with a reason, stay open briefly for late captures, then fail the run. */
  const deadLetter = async (step: ActivityStep, err: unknown): Promise<never> => {
    deadLetterReason = `${step} failed: ${describeFailure(err, retryFor(step).maxAttempts)}`;
    move("DEAD_LETTERED", `dead-letter:${step}`);
    log.error("workflow dead-lettered", { workflowId, correlationId: input.correlationId, reason: deadLetterReason });
    await sleep(config.lateCaptureGraceMs ?? DEFAULT_LATE_CAPTURE_GRACE_MS);
    await chargeSettled;
    throw ApplicationFailure.create({
      type: DEAD_LETTERED_ERROR,
      message: deadLetterReason,
      nonRetryable: true,
      details: [snapshot()],
    });
  };

  // ---- quote -> price ----
  let premium: number;
  try {
    premium = await activitiesFor(Steps.price).priceQuote({ workflowId, application: input.application });
  } catch (err) {
    return deadLetter(Steps.price, err);
  }
  premiumCents = premium;
  move("QUOTE_PRICED", "priced");

  // ---- bind: automatic for a priced quote in this demo; no side effect ----
  move("POLICY_BOUND", "auto-bind");

  // ---- payment: the charge response or the provider's callback, whichever comes first ----
  // WAIT_CANCELLATION_COMPLETED: if the callback wins and we cancel the charge,
  // its in-flight attempt still runs to the end (it cannot be recalled). The
  // workflow waits for it before closing, so it never closes while a charge
  // attempt is still outstanding, and the server's bookkeeping stays exact.
  const chargeScope = new CancellationScope();
  const charge = chargeScope
    .run(() =>
      activitiesFor(Steps.charge, { cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED }).chargePayment({
        workflowId,
        amountCents: premium,
      }),
    )
    .then(
      (r) => ({ ok: true as const, chargeId: r.chargeId }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  chargeSettled = charge;
  const outcome = await Promise.race([charge, condition(() => callbackConfirmation !== undefined).then(() => null)]);
  if (callbackConfirmation !== undefined) {
    // The callback won. Stop retrying the charge: the provider has told us it succeeded.
    chargeScope.cancel();
    paymentChargeId = callbackConfirmation;
    move("PAYMENT_CONFIRMED", "payment-callback");
  } else if (outcome?.ok) {
    paymentChargeId = outcome.chargeId;
    move("PAYMENT_CONFIRMED", "charge-response");
  } else {
    return deadLetter(Steps.charge, outcome?.err);
  }

  // ---- issue ----
  let issued: string;
  try {
    ({ policyNumber: issued } = await activitiesFor(Steps.issue).issuePolicy({ workflowId, premiumCents: premium }));
  } catch (err) {
    return deadLetter(Steps.issue, err);
  }
  policyNumber = issued;
  move("POLICY_ISSUED", "issued");

  // ---- deliver documents ----
  try {
    ({ deliveryId: documentDeliveryId } = await activitiesFor(Steps.deliver).deliverDocuments({
      workflowId,
      policyNumber: issued,
      recipient: input.application.contactEmail,
    }));
  } catch (err) {
    return deadLetter(Steps.deliver, err);
  }
  move("DOCUMENTS_DELIVERED", "documents-delivered");
  await chargeSettled;
  return snapshot();
}

/** Same wording as the hand-built relay: "exhausted N attempts: <Type>: <message>" or "non-retryable: ...". */
function describeFailure(err: unknown, maxAttempts: number): string {
  if (!(err instanceof ActivityFailure)) return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const cause = err.cause;
  const detail =
    cause instanceof ApplicationFailure
      ? `${cause.type ?? "Error"}: ${cause.message}`
      : cause instanceof TimeoutFailure
        ? `TimeoutFailure: activity ${String(cause.timeoutType)} timeout`
        : `${cause?.name ?? "Error"}: ${cause?.message ?? err.message}`;
  const retryState = String(err.retryState);
  if (retryState === "NON_RETRYABLE_FAILURE" || (cause instanceof ApplicationFailure && cause.nonRetryable)) {
    return `non-retryable: ${detail}`;
  }
  if (retryState === "MAXIMUM_ATTEMPTS_REACHED") return `exhausted ${maxAttempts} attempts: ${detail}`;
  return `${retryState.toLowerCase()}: ${detail}`;
}
