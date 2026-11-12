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
 * The Temporal service the tests run against:
 *
 * - By default, Temporal's standard time-skipping test environment
 *   (TestWorkflowEnvironment.createTimeSkipping): an in-memory service whose
 *   clock jumps forward whenever every workflow is waiting on a timer.
 * - With TEMPORAL_ADDRESS set, a real Temporal server instead (normally the
 *   dev server from `docker compose --profile temporal up temporal`), to check
 *   behaviour the test server does not model exactly. Tests that need time
 *   skipping are skipped there.
 *
 * Startup has a hard deadline, so it fails with a message instead of hanging.
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
  return withTimeout(
    TestWorkflowEnvironment.createTimeSkipping({ client }),
    TEST_SERVER_START_TIMEOUT_MS,
    "starting Temporal's time-skipping test environment",
  );
}
