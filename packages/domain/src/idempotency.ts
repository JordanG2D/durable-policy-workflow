/**
 * Idempotency keys for every external side effect. They are derived from the
 * workflow id alone, so they are identical across retries, crashes, workers
 * and (deliberately) across the two implementations.
 */
export const paymentIdempotencyKey = (workflowId: string) => `charge:${workflowId}`;
export const policyIdempotencyKey = (workflowId: string) => `issue:${workflowId}`;
export const documentIdempotencyKey = (workflowId: string) => `documents:${workflowId}`;
