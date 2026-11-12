import { RetryableError } from "@policy/domain/errors";

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
