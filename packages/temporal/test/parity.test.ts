import { PARITY_CONFIG, type ParityDriver } from "@policy/parity/driver";
import { defineParitySuite } from "@policy/parity/suite";
import type { PolicyWorkflowConfig } from "../src/definitions.js";
import { spans, startTemporalHarness } from "./support/harness.js";

/**
 * The shared parity suite, run against the Temporal implementation on
 * Temporal's time-skipping test server. The hand-built implementation runs
 * the same suite in packages/handbuilt/test/parity/parity.test.ts.
 */
const retry = {
  maxAttempts: PARITY_CONFIG.maxAttempts,
  initialIntervalMs: PARITY_CONFIG.initialBackoffMs,
  maxIntervalMs: PARITY_CONFIG.maxBackoffMs,
};
const parityWorkflowConfig: PolicyWorkflowConfig = {
  retry: { "quote.requested": retry, "policy.bound": retry, "payment.confirmed": retry, "policy.issued": retry },
  // One attempt may take at most this long; it is how a dead worker's attempt is detected.
  activityTimeoutMs: 2_000,
  chargeHeartbeatTimeoutMs: 1_000,
  // The default 24h late-capture window is kept: time skipping makes it free.
};

async function createTemporalDriver(): Promise<ParityDriver> {
  const h = await startTemporalHarness(parityWorkflowConfig);
  return {
    name: "temporal",
    fakes: { payment: h.payment, documents: h.documents, policies: h.policies },
    get apiUrl() {
      return h.apiUrl;
    },
    spans,
    reset: () => h.reset(),
    close: () => h.close(),
    async startWorker() {
      await h.startWorker({ timeoutMs: PARITY_CONFIG.externalCallTimeoutMs });
    },
    async startCrashingWorker(crashAt) {
      return h.spawnWorker({
        CRASH_AT: crashAt,
        EXTERNAL_CALL_TIMEOUT_MS: String(PARITY_CONFIG.externalCallTimeoutMs),
        // No sticky queue on the worker that is about to die: the time-skipping test server
        // does not hand a dead worker's sticky tasks back to the shared queue (the real server does).
        WORKER_MAX_CACHED_WORKFLOWS: "0",
      });
    },
    waitUntilSettled: (id) => h.waitUntilSettled(id),
    async policiesIssued(id) {
      return h.policies.issuedFor(id);
    },
  };
}

defineParitySuite(createTemporalDriver);
