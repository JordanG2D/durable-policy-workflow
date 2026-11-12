import { createFakePolicyRegistry } from "@policy/domain/fakes/policyRegistry";
import { isTerminal } from "@policy/domain/stateMachine";
import { PARITY_CONFIG, type ParityDriver } from "@policy/parity/driver";
import { defineParitySuite } from "@policy/parity/suite";
import { getWorkflow, listTransitions } from "../../src/workflow/repository.js";
import { outboxSettled, spans, startHarness, waitFor } from "../helpers/harness.js";
import { spawnWorker } from "../helpers/workerProcess.js";

/**
 * The shared parity suite, run against the hand-built implementation
 * (Postgres outbox + leased relay). The Temporal implementation runs the
 * same suite in packages/temporal/test/parity.test.ts.
 */
async function createHandBuiltDriver(): Promise<ParityDriver> {
  const h = await startHarness();
  // The hand-built implementation numbers policies with a Postgres sequence; the registry fake is unused.
  const policies = createFakePolicyRegistry();
  const retry = {
    maxAttempts: PARITY_CONFIG.maxAttempts,
    baseDelayMs: PARITY_CONFIG.initialBackoffMs,
    maxDelayMs: PARITY_CONFIG.maxBackoffMs,
  };
  return {
    name: "hand-built",
    fakes: { payment: h.payment, documents: h.documents, policies },
    apiUrl: h.apiUrl,
    spans,
    reset: () => h.reset(),
    close: () => h.close(),
    async startWorker() {
      await h.startWorker({ retry, externalCallTimeoutMs: PARITY_CONFIG.externalCallTimeoutMs });
    },
    async startCrashingWorker(crashAt) {
      const { exited } = spawnWorker(h, {
        CRASH_AT: crashAt,
        EXTERNAL_CALL_TIMEOUT_MS: String(PARITY_CONFIG.externalCallTimeoutMs),
        RETRY_MAX_ATTEMPTS: String(retry.maxAttempts),
        RETRY_BASE_DELAY_MS: String(retry.baseDelayMs),
        RETRY_MAX_DELAY_MS: String(retry.maxDelayMs),
      });
      return { exited };
    },
    async waitUntilSettled(id) {
      await waitFor(
        async () => {
          const wf = await getWorkflow(h.pool, id);
          return !!wf && isTerminal(wf.state) && (await outboxSettled(h.pool, id));
        },
        { timeoutMs: 20_000, what: `workflow ${id} to settle` },
      );
    },
    async policiesIssued(id) {
      // policy_number is UNIQUE and is written once, by the POLICY_ISSUED transition.
      return (await listTransitions(h.pool, id)).filter((t) => t.to === "POLICY_ISSUED").length;
    },
  };
}

defineParitySuite(createHandBuiltDriver);
