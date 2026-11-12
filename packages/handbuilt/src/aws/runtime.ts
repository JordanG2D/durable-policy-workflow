import pg from "pg";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createLogger } from "@policy/domain/logger";
import { rulePricing } from "@policy/domain/pricing";
import { loadConfig } from "../config.js";
import { buildServer } from "../http/server.js";
import { createMetrics, registerOutboxGauges } from "../observability/metrics.js";
import { Relay } from "../outbox/relay.js";
import { createDeadLetterHandler, createStepHandlers } from "../workflow/steps.js";
import { mirrorDeadLetter } from "./deadLetter.js";
import { createDemoProviders } from "./demoProviders.js";
import { claimEvent, createQueueWorker, type QueueTransport } from "./queue.js";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required environment variable ${key}`);
  return value;
}

export async function createRuntime() {
  // Demo deployment must never silently fall back to real external providers.
  if (required("DEMO_MODE") !== "true") throw new Error("AWS adapter requires DEMO_MODE=true");
  const secretClient = new SecretsManagerClient({});
  let secret;
  try { secret = await secretClient.send(new GetSecretValueCommand({ SecretId: required("DATABASE_SECRET_ARN") })); }
  finally { secretClient.destroy(); }
  const credentials: unknown = JSON.parse(secret.SecretString ?? "null");
  if (!credentials || typeof credentials !== "object" || !("username" in credentials) ||
      !("password" in credentials) || typeof credentials.username !== "string" || typeof credentials.password !== "string") {
    throw new Error("database secret must contain username and password");
  }
  const pool = new pg.Pool({
    host: required("DATABASE_HOST"), port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME ?? "policy", user: credentials.username, password: credentials.password,
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: true },
  });
  pool.on("error", () => undefined);
  // Config's database URL is not used here: credentials stay out of URLs/logs.
  const config = loadConfig({ ...process.env, DATABASE_URL: "postgresql://unused", ROLE: "worker" });
  const logger = createLogger(config.logLevel);
  const metrics = createMetrics({ defaultMetrics: false });
  registerOutboxGauges(metrics, pool);
  const queueClient = new SQSClient({});
  const queue: QueueTransport = {
    async send(queueUrl, body) { await queueClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body })); },
  };
  const providers = createDemoProviders(pool);
  const relay = new Relay({
    pool, handlers: createStepHandlers({ pool, log: logger, metrics, pricing: rulePricing, ...providers,
      paymentCallbackUrl: "https://synthetic.invalid/no-callback" }),
    onDeadLetter: createDeadLetterHandler({ log: logger, metrics }), retry: config.retry, metrics, logger,
    pollIntervalMs: config.relay.pollIntervalMs, batchSize: config.relay.batchSize, leaseMs: config.relay.leaseMs,
  });
  const queueUrl = required("QUEUE_URL");
  const dlqUrl = required("DLQ_URL");
  const worker = createQueueWorker({
    claim: (id) => claimEvent(pool, id, config.relay.leaseMs),
    relay: { async processClaim(claim) {
      if (claim.type !== "workflow.dead_lettered") return relay.processClaim(claim);
      // This is a durable DLQ mirror, not a domain step. Never exhaust its
      // attempt budget: AWS outages must not turn the last failure notice into
      // another dead DB row. Crash after send can duplicate the stable eventId.
      await mirrorDeadLetter(pool, queue, dlqUrl, claim);
    } },
  });
  return { pool, queue, queueUrl, worker, server: buildServer({ pool, log: logger, metrics }) };
}

let cached: ReturnType<typeof createRuntime> | undefined;
export function runtime(): ReturnType<typeof createRuntime> {
  // Failed initialization must not poison a warm Lambda forever.
  cached ??= createRuntime().catch((error: unknown) => { cached = undefined; throw error; });
  return cached;
}
