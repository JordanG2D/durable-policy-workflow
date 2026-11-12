import type { PolicyWorkflowConfig } from "./definitions.js";
import { TASK_QUEUE } from "./definitions.js";

export interface TemporalConfig {
  readonly temporalAddress: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly port: number;
  readonly logLevel: string;
  readonly paymentProviderUrl: string;
  readonly documentServiceUrl: string;
  readonly policyRegistryUrl: string;
  readonly paymentCallbackUrl: string;
  readonly externalCallTimeoutMs: number;
  /** Optional prebuilt workflow bundle; otherwise workflows are bundled at startup. */
  readonly workflowBundlePath: string | undefined;
  readonly maxCachedWorkflows: number | undefined;
  readonly otlpEndpoint: string | undefined;
  readonly workflowConfig: PolicyWorkflowConfig | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

const str = (env: Env, key: string, fallback: string) => (env[key] ? env[key] : fallback);

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: Env = process.env): TemporalConfig {
  const port = int(env, "PORT", 3100);
  const steps = ["quote.requested", "policy.bound", "payment.confirmed", "policy.issued"] as const;
  // RETRY_* (same names as the hand-built service) override every activity's retry policy.
  const retryOverride =
    env.RETRY_MAX_ATTEMPTS || env.RETRY_BASE_DELAY_MS || env.RETRY_MAX_DELAY_MS
      ? {
          maxAttempts: int(env, "RETRY_MAX_ATTEMPTS", 6),
          initialIntervalMs: int(env, "RETRY_BASE_DELAY_MS", 500),
          maxIntervalMs: int(env, "RETRY_MAX_DELAY_MS", 30_000),
        }
      : undefined;
  const activityTimeoutMs = env.ACTIVITY_TIMEOUT_MS ? int(env, "ACTIVITY_TIMEOUT_MS", 10_000) : undefined;
  const workflowConfig: PolicyWorkflowConfig | undefined =
    retryOverride || activityTimeoutMs
      ? {
          ...(retryOverride ? { retry: Object.fromEntries(steps.map((s) => [s, retryOverride])) } : {}),
          ...(activityTimeoutMs ? { activityTimeoutMs } : {}),
        }
      : undefined;
  return {
    temporalAddress: str(env, "TEMPORAL_ADDRESS", "localhost:7233"),
    namespace: str(env, "TEMPORAL_NAMESPACE", "default"),
    taskQueue: str(env, "TEMPORAL_TASK_QUEUE", TASK_QUEUE),
    port,
    logLevel: str(env, "LOG_LEVEL", "info"),
    paymentProviderUrl: str(env, "PAYMENT_PROVIDER_URL", "http://localhost:4001"),
    documentServiceUrl: str(env, "DOCUMENT_SERVICE_URL", "http://localhost:4002"),
    policyRegistryUrl: str(env, "POLICY_REGISTRY_URL", "http://localhost:4003"),
    paymentCallbackUrl: str(env, "PAYMENT_CALLBACK_URL", `http://localhost:${port}/webhooks/payments`),
    externalCallTimeoutMs: int(env, "EXTERNAL_CALL_TIMEOUT_MS", 2_000),
    workflowBundlePath: env.WORKFLOW_BUNDLE_PATH || undefined,
    maxCachedWorkflows: env.WORKER_MAX_CACHED_WORKFLOWS ? int(env, "WORKER_MAX_CACHED_WORKFLOWS", 0) : undefined,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    workflowConfig,
  };
}
