/**
 * Re-record the workflow histories used by test/replay.test.ts.
 *
 *   npm run record-histories -w @policy/temporal
 *
 * Run it when the workflow changes in a way that is *meant* to be
 * incompatible with running workflows (and ship that change with
 * versioning/patching instead, if workflows of the old shape may still be
 * open). Uses the time-skipping test server, or the server at TEMPORAL_ADDRESS.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { sampleApplication } from "@policy/parity/http";
import type { PolicyWorkflowConfig } from "../../src/definitions.js";
import { startTemporalHarness, type TemporalHarness } from "./harness.js";

const retry = { maxAttempts: 4, initialIntervalMs: 20, maxIntervalMs: 100 };
const config: PolicyWorkflowConfig = {
  retry: { "quote.requested": retry, "policy.bound": retry, "payment.confirmed": retry, "policy.issued": retry },
  activityTimeoutMs: 2_000,
  chargeHeartbeatTimeoutMs: 1_000,
  // Short, so recording does not depend on time skipping.
  lateCaptureGraceMs: 1_000,
};

const scenarios: Record<string, (h: TemporalHarness) => void> = {
  // Charge response confirms payment; callbacks off.
  "happy-path": (h) => h.payment.setFaults({ callbacks: false }),
  // Callback beats a slow charge response; two duplicate callbacks follow.
  "callback-wins-with-duplicates": (h) =>
    h.payment.setFaults({ responseDelayMs: 1_500, callbacks: true, callbackCopies: 3, callbackDelayMs: 50 }),
  // Document service down: retries exhausted, dead-lettered.
  "documents-down-dead-lettered": (h) => {
    h.payment.setFaults({ callbacks: false });
    h.documents.setFaults({ down: true });
  },
};

const outDir = fileURLToPath(new URL("../fixtures/histories/", import.meta.url));
const h = await startTemporalHarness(config);
try {
  for (const [name, arrange] of Object.entries(scenarios)) {
    await h.reset();
    arrange(h);
    await h.startWorker();
    const res = await fetch(`${h.apiUrl}/v1/policy-applications`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `record-${name}-${Date.now()}` },
      body: JSON.stringify(sampleApplication),
    });
    const { workflowId } = (await res.json()) as { workflowId: string };
    await h.payment.drainCallbacks();
    await h.waitUntilSettled(workflowId, 30_000);
    const handle = h.env.client.workflow.getHandle(workflowId);
    await handle.result().catch(() => undefined);
    await writeFile(`${outDir}${name}.json`, historyToJSON(await handle.fetchHistory()) + "\n");
    console.log(`recorded ${name}`);
  }
} finally {
  await h.close();
}
