import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Worker, WorkflowBundle } from "@temporalio/worker";
import type { FastifyInstance } from "fastify";
import { httpDocumentGateway, httpPaymentGateway, httpPolicyGateway } from "@policy/domain/clients/gateways";
import { createFakeDocumentService, type FakeDocumentService } from "@policy/domain/fakes/documentService";
import { createFakePaymentProvider, type FakePaymentProvider } from "@policy/domain/fakes/paymentProvider";
import { createFakePolicyRegistry, type FakePolicyRegistry } from "@policy/domain/fakes/policyRegistry";
import { createLogger } from "@policy/domain/logger";
import { rulePricing, type PricingEngine } from "@policy/domain/pricing";
import { initTracing } from "@policy/domain/tracing";
import type { ActivityDeps } from "../../src/activities.js";
import { buildApi } from "../../src/api.js";
import { stateQuery, type PolicyWorkflowConfig } from "../../src/definitions.js";
import { bundleWorkflows, createWorker } from "../../src/worker.js";
import { createTestEnv, withTimeout } from "./env.js";

export const spans = new InMemorySpanExporter();
initTracing({ serviceName: "policy-workflow-temporal-test", exporter: spans });

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const urlOf = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/**
 * Test harness for the Temporal implementation: the time-skipping server, the
 * three fake providers, the real HTTP API, and in-process or out-of-process
 * workers. Each `reset()` moves to a fresh task queue, so nothing left over
 * from a previous test (e.g. a dead-lettered workflow in its grace period)
 * can be picked up by the next test's workers.
 */
export interface TemporalHarness {
  readonly env: TestWorkflowEnvironment;
  readonly bundle: WorkflowBundle;
  readonly payment: FakePaymentProvider;
  readonly documents: FakeDocumentService;
  readonly policies: FakePolicyRegistry;
  readonly apiUrl: string;
  readonly taskQueue: string;
  /** Rebuild the API with a workflow config (retry policies, timeouts) for subsequent starts. */
  useWorkflowConfig(config: PolicyWorkflowConfig | undefined): Promise<void>;
  activityDeps(timeoutMs: number, overrides?: { pricing?: PricingEngine }): ActivityDeps;
  startWorker(opts?: { timeoutMs?: number; pricing?: PricingEngine }): Promise<Worker>;
  /**
   * Wait until the workflow is closed (time-skipping server: awaiting the
   * result lets the clock jump over backoffs and the late-capture window) or,
   * on a real server, until it is terminal with no activity still pending.
   * Fails after `timeoutMs` with the workflow's status instead of hanging.
   */
  waitUntilSettled(workflowId: string, timeoutMs?: number): Promise<void>;
  /** Run src/main-worker.ts in a child process; it SIGKILLs itself at `crashAt`. */
  spawnWorker(env: Record<string, string>): Promise<{ exited: Promise<NodeJS.Signals | number | null> }>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startTemporalHarness(config?: PolicyWorkflowConfig): Promise<TemporalHarness> {
  const env = await createTestEnv();
  const bundle = await withTimeout(bundleWorkflows(), 60_000, "bundling workflow code");
  const bundleDir = await mkdtemp(join(tmpdir(), "policy-workflow-bundle-"));
  const bundlePath = join(bundleDir, "workflow-bundle.js");
  await writeFile(bundlePath, bundle.code);

  const payment = createFakePaymentProvider();
  const documents = createFakeDocumentService();
  const policies = createFakePolicyRegistry();
  for (const f of [payment, documents, policies]) await f.app.listen({ host: "127.0.0.1", port: 0 });

  let taskQueue = `policy-test-${randomUUID()}`;
  let workflowConfig = config;
  let api: FastifyInstance | undefined;
  const startApi = async () => {
    await api?.close();
    api = buildApi({
      client: env.client,
      taskQueue,
      log: createLogger("silent"),
      ...(workflowConfig ? { workflowConfig } : {}),
    });
    await api.listen({ host: "127.0.0.1", port: 0 });
  };
  await startApi();

  const running: { worker: Worker; done: Promise<void> }[] = [];
  const children = new Set<ChildProcess>();

  const h: TemporalHarness = {
    env,
    bundle,
    payment,
    documents,
    policies,
    get apiUrl() {
      return urlOf(api!);
    },
    get taskQueue() {
      return taskQueue;
    },
    async useWorkflowConfig(c) {
      workflowConfig = c;
      await startApi();
    },
    activityDeps: (timeoutMs, overrides = {}) => ({
      pricing: overrides.pricing ?? rulePricing,
      payments: httpPaymentGateway(urlOf(payment.app), timeoutMs),
      policies: httpPolicyGateway(urlOf(policies.app), timeoutMs),
      documents: httpDocumentGateway(urlOf(documents.app), timeoutMs),
      paymentCallbackUrl: `${h.apiUrl}/webhooks/payments`,
    }),
    async startWorker(opts = {}) {
      const worker = await createWorker({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: bundle,
        activities: h.activityDeps(opts.timeoutMs ?? 300, opts.pricing ? { pricing: opts.pricing } : {}),
        stickyQueueScheduleToStartTimeoutMs: 1_000,
      });
      running.push({ worker, done: worker.run() });
      return worker;
    },
    async waitUntilSettled(workflowId, timeoutMs = 30_000) {
      const handle = env.client.workflow.getHandle(workflowId);
      const settled = env.supportsTimeSkipping
        ? handle.result().then(
            () => undefined,
            () => undefined,
          )
        : (async () => {
            for (;;) {
              const d = await handle.describe();
              const state = d.status.name === "RUNNING" ? (await handle.query(stateQuery)).state : "closed";
              const terminal = state === "closed" || state === "DOCUMENTS_DELIVERED" || state === "DEAD_LETTERED";
              if (terminal && (d.raw.pendingActivities?.length ?? 0) === 0) return;
              await sleep(50);
            }
          })();
      try {
        await withTimeout(settled, timeoutMs, `workflow ${workflowId} to settle`);
      } catch (err) {
        const d = await handle.describe().catch(() => undefined);
        throw new Error(
          `${(err as Error).message}; status=${d?.status.name}, pending activities=${d?.raw.pendingActivities?.length}`,
          { cause: err },
        );
      }
    },
    async spawnWorker(extraEnv) {
      const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", "src/main-worker.ts"], {
        cwd: packageRoot,
        env: {
          ...process.env,
          TEMPORAL_ADDRESS: env.address,
          TEMPORAL_TASK_QUEUE: taskQueue,
          WORKFLOW_BUNDLE_PATH: bundlePath,
          PAYMENT_PROVIDER_URL: urlOf(payment.app),
          DOCUMENT_SERVICE_URL: urlOf(documents.app),
          POLICY_REGISTRY_URL: urlOf(policies.app),
          PAYMENT_CALLBACK_URL: `${h.apiUrl}/webhooks/payments`,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let output = "";
      const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
        child.on("exit", (code, signal) => {
          children.delete(child);
          if (signal !== "SIGKILL" && code !== 0) console.error(output);
          resolve(signal ?? code);
        });
      });
      // Resolve once the worker is polling, so the test controls what it sees.
      const ready = new Promise<void>((resolve, reject) => {
        const onData = (d: Buffer) => {
          output += d.toString();
          if (output.includes("worker running")) resolve();
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
        void exited.then(() => reject(new Error(`worker exited before it started:\n${output}`)));
      });
      await withTimeout(ready, 30_000, "spawned worker to start polling").catch((err: unknown) => {
        child.kill("SIGKILL");
        throw err;
      });
      return { exited };
    },
    async reset() {
      for (const c of children) c.kill("SIGKILL");
      await Promise.all(
        running.splice(0).map(async ({ worker, done }) => {
          if (worker.getState() === "RUNNING") worker.shutdown();
          await withTimeout(done, 15_000, "worker shutdown");
        }),
      );
      await payment.drainCallbacks();
      payment.reset();
      documents.reset();
      policies.reset();
      spans.reset();
      taskQueue = `policy-test-${randomUUID()}`;
      await startApi();
    },
    async close() {
      await h.reset();
      await api?.close();
      for (const f of [payment, documents, policies]) await f.app.close();
      await withTimeout(env.teardown(), 30_000, "Temporal test environment teardown");
    },
  };
  return h;
}
