import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { clientInterceptors } from "../../src/tracing.js";

/** Reject with a clear message if `p` has not settled within `ms`. Nothing in these tests may wait silently. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const TEST_SERVER_START_TIMEOUT_MS = Number(process.env.TEMPORAL_TEST_SERVER_START_TIMEOUT_MS ?? 90_000);

/**
 * The Temporal service the tests run against, in order of preference:
 *
 * 1. TEMPORAL_ADDRESS set: an already running server, normally the dev server
 *    from `docker compose --profile temporal up temporal`. No time skipping,
 *    so tests that only make sense with it are skipped.
 * 2. Otherwise Temporal's time-skipping test server, an in-memory service
 *    whose clock jumps forward whenever every workflow is waiting on a timer.
 *    The SDK downloads it on first use; TEMPORAL_TEST_SERVER_PATH can point at
 *    an existing executable instead.
 *
 * Startup has a hard deadline: a blocked download fails the run with a
 * message instead of hanging it.
 */
export function createTestEnv(): Promise<TestWorkflowEnvironment> {
  // Expected failures (retries, dead-letters) are the point of these tests; only print real errors.
  try {
    Runtime.install({ logger: new DefaultLogger((process.env.TEMPORAL_LOG_LEVEL as "ERROR") ?? "ERROR") });
  } catch {
    // already installed in this process
  }
  const client = { interceptors: clientInterceptors() };
  const address = process.env.TEMPORAL_ADDRESS;
  if (address) {
    return withTimeout(
      TestWorkflowEnvironment.createFromExistingServer({ address, client }),
      TEST_SERVER_START_TIMEOUT_MS,
      `connecting to the Temporal server at ${address}`,
    );
  }
  const path = process.env.TEMPORAL_TEST_SERVER_PATH;
  return withTimeout(
    TestWorkflowEnvironment.createTimeSkipping({
      ...(path ? { server: { executable: { type: "existing-path", path } } } : {}),
      client,
    }),
    TEST_SERVER_START_TIMEOUT_MS,
    "starting Temporal's time-skipping test server (if its download is blocked, run the dev server with " +
      "`docker compose --profile temporal up -d temporal` and set TEMPORAL_ADDRESS=localhost:7233)",
  );
}
