import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createApp, type App, type AppOverrides } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import type { Pool } from "../../src/db/pool.js";
import { createFakeDocumentService, type FakeDocumentService } from "../../src/fakes/documentService.js";
import { createFakePaymentProvider, type FakePaymentProvider } from "../../src/fakes/paymentProvider.js";
import { createLogger, type Logger } from "../../src/observability/logger.js";
import { initTracing } from "../../src/observability/tracing.js";
import { getWorkflow, listTransitions } from "../../src/workflow/repository.js";
import type { WorkflowState } from "../../src/domain/stateMachine.js";
import { TEST_DATABASE_URL, resetDb, sampleApplication, setupDb } from "./db.js";

export const spans = new InMemorySpanExporter();
initTracing({ serviceName: "policy-workflow-test", exporter: spans });

export interface LogSink {
  readonly lines: Record<string, unknown>[];
  readonly logger: Logger;
}

export function logSink(level = "debug"): LogSink {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { lines, logger };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: TEST_DATABASE_URL,
    port: 0,
    role: "all",
    logLevel: "silent",
    paymentProviderUrl: "http://127.0.0.1:1",
    documentServiceUrl: "http://127.0.0.1:1",
    paymentCallbackUrl: "http://127.0.0.1:1/webhooks/payments",
    externalCallTimeoutMs: 300,
    relay: { pollIntervalMs: 20, batchSize: 10, leaseMs: 2_000 },
    retry: { maxAttempts: 4, baseDelayMs: 20, maxDelayMs: 100 },
    otlpEndpoint: undefined,
    ...overrides,
  };
}

const urlOf = (app: { server: { address(): string | AddressInfo | null } }) => {
  const addr = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
};

export interface Harness {
  readonly pool: Pool;
  readonly api: App;
  readonly apiUrl: string;
  readonly payment: FakePaymentProvider;
  readonly paymentUrl: string;
  readonly documents: FakeDocumentService;
  readonly documentsUrl: string;
  readonly apiLogs: LogSink;
  /** Build a worker process-equivalent (own pool, own relay, own metrics). Not started. */
  worker(config?: Partial<Config>, overrides?: AppOverrides): App;
  /** Build and start a worker; it is stopped by `reset`/`close`. */
  startWorker(config?: Partial<Config>, overrides?: AppOverrides): Promise<App>;
  workerConfig(config?: Partial<Config>): Config;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const pool = await setupDb();
  const payment = createFakePaymentProvider();
  const documents = createFakeDocumentService();
  await payment.app.listen({ host: "127.0.0.1", port: 0 });
  await documents.app.listen({ host: "127.0.0.1", port: 0 });
  const paymentUrl = `http://127.0.0.1:${(payment.app.server.address() as AddressInfo).port}`;
  const documentsUrl = `http://127.0.0.1:${(documents.app.server.address() as AddressInfo).port}`;

  const apiLogs = logSink();
  const api = createApp(testConfig({ role: "api" }), { logger: apiLogs.logger });
  await api.start();
  const apiUrl = urlOf(api.server!);

  const running: App[] = [];
  const workerConfig = (config: Partial<Config> = {}) =>
    testConfig({
      role: "worker",
      paymentProviderUrl: paymentUrl,
      documentServiceUrl: documentsUrl,
      paymentCallbackUrl: `${apiUrl}/webhooks/payments`,
      ...config,
    });
  const worker = (config: Partial<Config> = {}, overrides: AppOverrides = {}) =>
    createApp(workerConfig(config), { logger: createLogger("silent"), ...overrides });

  const stopWorkers = async () => {
    await Promise.all(running.splice(0).map((w) => w.stop()));
  };

  return {
    pool,
    api,
    apiUrl,
    payment,
    paymentUrl,
    documents,
    documentsUrl,
    apiLogs,
    worker,
    workerConfig,
    async startWorker(config, overrides) {
      const w = worker(config, overrides);
      await w.start();
      running.push(w);
      return w;
    },
    async reset() {
      await stopWorkers();
      await payment.drainCallbacks();
      payment.reset();
      documents.reset();
      apiLogs.lines.length = 0;
      api.metrics.registry.resetMetrics();
      spans.reset();
      await resetDb(pool);
    },
    async close() {
      await stopWorkers();
      await payment.drainCallbacks();
      await api.stop();
      await payment.app.close();
      await documents.app.close();
      await pool.end();
    },
  };
}

export async function submitApplication(
  apiUrl: string,
  opts: { key?: string; body?: unknown; correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${apiUrl}/v1/policy-applications`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.key === "" ? {} : { "idempotency-key": opts.key ?? `key-${randomUUID()}` }),
      ...(opts.correlationId ? { "x-correlation-id": opts.correlationId } : {}),
    },
    body: JSON.stringify(opts.body ?? sampleApplication),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

export async function startWorkflow(apiUrl: string): Promise<string> {
  const res = await submitApplication(apiUrl);
  if (res.status !== 202) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.workflowId as string;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 25, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export async function waitForState(pool: Pool, id: string, state: WorkflowState, timeoutMs = 10_000) {
  return waitFor(
    async () => {
      const wf = await getWorkflow(pool, id);
      return wf?.state === state ? wf : undefined;
    },
    { timeoutMs, what: `workflow ${id} to reach ${state}` },
  );
}

/** Each state the workflow entered, in order. The DB also enforces at most once per state. */
export async function statesEntered(pool: Pool, id: string): Promise<string[]> {
  return (await listTransitions(pool, id)).map((t) => t.to);
}

export const HAPPY_PATH = [
  "QUOTE_REQUESTED",
  "QUOTE_PRICED",
  "POLICY_BOUND",
  "PAYMENT_CONFIRMED",
  "POLICY_ISSUED",
  "DOCUMENTS_DELIVERED",
];

/** No outbox work left for the workflow (all done or dead). */
export async function outboxSettled(pool: Pool, id: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM outbox WHERE workflow_id = $1 AND status = 'pending'",
    [id],
  );
  return rows[0]?.n === "0";
}

export async function metricValue(app: App, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = (await app.metrics.registry.getSingleMetric(name)?.get()) as
    | { values: { value: number; labels: Record<string, string | number> }[] }
    | undefined;
  if (!metric) return 0;
  return metric.values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}
