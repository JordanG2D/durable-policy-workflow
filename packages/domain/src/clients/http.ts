import { NonRetryableError, RetryableError } from "../errors.js";
import { traceHeaders } from "../tracing.js";

/**
 * POST JSON with a hard timeout and failure classification:
 *   timeout / connection error / 5xx / 429  -> RetryableError
 *   other 4xx                               -> NonRetryableError
 * A timeout is ambiguous (the remote side may have done the work), which is
 * exactly why every call that has a side effect carries an idempotency key.
 */
export async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...traceHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RetryableError(`timeout after ${timeoutMs}ms calling ${url}`);
    }
    throw new RetryableError(`network error calling ${url}: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (res.ok) return JSON.parse(text) as T;
  const detail = `HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`;
  if (res.status >= 500 || res.status === 429) throw new RetryableError(detail);
  throw new NonRetryableError(detail);
}
