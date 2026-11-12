/**
 * Retry policy: capped exponential backoff with "full jitter".
 *
 *   delay(n) = random(0, min(maxDelayMs, baseDelayMs * 2^(n-1)))
 *
 * Full jitter spreads retries from many workflows that failed together (for
 * example when a dependency comes back) instead of synchronising them.
 */

export interface RetryPolicy {
  /** Total attempts including the first one. After this, the work is dead-lettered. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be an integer >= 1");
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError("require 0 <= baseDelayMs <= maxDelayMs");
  }
  return policy;
}

/** Upper bound of the delay after the given (1-based) failed attempt, before jitter. */
export function backoffCeilingMs(policy: RetryPolicy, attempt: number): number {
  if (attempt < 1) throw new RangeError("attempt is 1-based");
  // Clamp the exponent so huge attempt numbers cannot overflow to Infinity.
  const exp = Math.min(attempt - 1, 30);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exp);
}

/**
 * Delay before the next attempt after `attempt` attempts have failed.
 * `random` is injectable so tests are deterministic.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * backoffCeilingMs(policy, attempt));
}

export type RetryDecision =
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "dead-letter"; readonly reason: string };

export function decideRetry(
  policy: RetryPolicy,
  attemptsSoFar: number,
  error: { readonly message: string; readonly retryable: boolean },
  random: () => number = Math.random,
): RetryDecision {
  if (!error.retryable) {
    return { kind: "dead-letter", reason: `non-retryable: ${error.message}` };
  }
  if (attemptsSoFar >= policy.maxAttempts) {
    return {
      kind: "dead-letter",
      reason: `exhausted ${policy.maxAttempts} attempts: ${error.message}`,
    };
  }
  return { kind: "retry", delayMs: backoffDelayMs(policy, attemptsSoFar, random) };
}
