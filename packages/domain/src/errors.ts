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

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof Error && err.name === "IllegalTransitionError") return false;
  return true;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
