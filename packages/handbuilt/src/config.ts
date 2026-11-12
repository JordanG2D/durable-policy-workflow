import { validateRetryPolicy, type RetryPolicy } from "./outbox/retryPolicy.js";

export type Role = "api" | "worker" | "all";

export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly role: Role;
  readonly logLevel: string;
  readonly paymentProviderUrl: string;
  readonly documentServiceUrl: string;
  readonly paymentCallbackUrl: string;
  readonly externalCallTimeoutMs: number;
  readonly relay: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
  };
  readonly retry: RetryPolicy;
  readonly otlpEndpoint: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, key: string, fallback?: string): string {
  const v = env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${key}`);
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const role = str(env, "ROLE", "all");
  if (role !== "api" && role !== "worker" && role !== "all") {
    throw new Error(`ROLE must be api, worker or all (got ${role})`);
  }
  const port = int(env, "PORT", 3000);
  return {
    databaseUrl: str(env, "DATABASE_URL"),
    port,
    role,
    logLevel: str(env, "LOG_LEVEL", "info"),
    paymentProviderUrl: str(env, "PAYMENT_PROVIDER_URL", "http://localhost:4001"),
    documentServiceUrl: str(env, "DOCUMENT_SERVICE_URL", "http://localhost:4002"),
    paymentCallbackUrl: str(
      env,
      "PAYMENT_CALLBACK_URL",
      `http://localhost:${port}/webhooks/payments`,
    ),
    externalCallTimeoutMs: int(env, "EXTERNAL_CALL_TIMEOUT_MS", 2_000),
    relay: {
      pollIntervalMs: int(env, "RELAY_POLL_INTERVAL_MS", 250),
      batchSize: int(env, "RELAY_BATCH_SIZE", 10),
      leaseMs: int(env, "RELAY_LEASE_MS", 15_000),
    },
    retry: validateRetryPolicy({
      maxAttempts: int(env, "RETRY_MAX_ATTEMPTS", 6),
      baseDelayMs: int(env, "RETRY_BASE_DELAY_MS", 500),
      maxDelayMs: int(env, "RETRY_MAX_DELAY_MS", 30_000),
    }),
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  };
}
