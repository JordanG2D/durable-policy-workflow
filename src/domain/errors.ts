/**
 * Error taxonomy used by the relay to decide what to do with a failed step.
 * Anything that is not explicitly non-retryable is retried (timeouts, 5xx,
 * connection errors, deadlocks), because retrying is safe: every side effect
 * is guarded by an idempotency key or a database constraint.
 */

export class RetryableError extends Error {
  override readonly name: string = "RetryableError";
  readonly retryable = true;
}

export class NonRetryableError extends Error {
  override readonly name: string = "NonRetryableError";
  readonly retryable = false;
}

/** The workflow row was changed by someone else between read and write. */
export class ConcurrentStateChangeError extends RetryableError {
  override readonly name = "ConcurrentStateChangeError";
}

/**
 * This worker's outbox lease was taken over (it expired and another worker
 * reclaimed the row). The step's result must be discarded; the new owner is
 * responsible for the row now.
 */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof Error && err.name === "IllegalTransitionError") return false;
  return true;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
