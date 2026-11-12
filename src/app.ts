import type { FastifyInstance } from "fastify";
import {
  httpDocumentGateway,
  httpPaymentGateway,
  type DocumentGateway,
  type PaymentGateway,
} from "./clients/gateways.js";
import type { Config } from "./config.js";
import { createPool, type Pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { rulePricing, type PricingEngine } from "./domain/pricing.js";
import type { CrashHook } from "./faults/crash.js";
import { buildServer } from "./http/server.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { createMetrics, registerOutboxGauges, type Metrics } from "./observability/metrics.js";
import { Relay } from "./outbox/relay.js";
import { createDeadLetterHandler, createStepHandlers } from "./workflow/steps.js";

export interface AppOverrides {
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly pricing?: PricingEngine;
  readonly payments?: PaymentGateway;
  readonly documents?: DocumentGateway;
  readonly crash?: CrashHook;
  readonly random?: () => number;
  readonly relayOwner?: string;
}

export interface App {
  readonly config: Config;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly server: FastifyInstance | undefined;
  readonly relay: Relay | undefined;
  /** Runs migrations, starts the HTTP server and/or relay depending on role. */
  start(): Promise<void>;
  /** Graceful stop: stop claiming, finish in-flight steps, close server and pool. */
  stop(): Promise<void>;
}

export function createApp(config: Config, overrides: AppOverrides = {}): App {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const metrics = overrides.metrics ?? createMetrics();
  const pool = createPool(config.databaseUrl);
  registerOutboxGauges(metrics, pool);

  const runsWorker = config.role === "worker" || config.role === "all";
  const runsApi = config.role === "api" || config.role === "all";

  const relay = runsWorker
    ? new Relay({
        pool,
        handlers: createStepHandlers({
          pool,
          log: logger,
          metrics,
          pricing: overrides.pricing ?? rulePricing,
          payments: overrides.payments ?? httpPaymentGateway(config.paymentProviderUrl, config.externalCallTimeoutMs),
          documents:
            overrides.documents ?? httpDocumentGateway(config.documentServiceUrl, config.externalCallTimeoutMs),
          paymentCallbackUrl: config.paymentCallbackUrl,
          ...(overrides.crash ? { crash: overrides.crash } : {}),
        }),
        onDeadLetter: createDeadLetterHandler({ log: logger, metrics }),
        retry: config.retry,
        metrics,
        logger,
        pollIntervalMs: config.relay.pollIntervalMs,
        batchSize: config.relay.batchSize,
        leaseMs: config.relay.leaseMs,
        ...(overrides.crash ? { crash: overrides.crash } : {}),
        ...(overrides.random ? { random: overrides.random } : {}),
        ...(overrides.relayOwner ? { owner: overrides.relayOwner } : {}),
      })
    : undefined;

  // Worker-only processes still serve health and metrics on PORT.
  const server = buildServer({
    pool,
    log: logger,
    metrics,
    ...(relay ? { isWorkerHealthy: () => relay.isRunning } : {}),
  });

  return {
    config,
    pool,
    logger,
    metrics,
    server: runsApi || runsWorker ? server : undefined,
    relay,
    async start() {
      const ran = await migrate(pool);
      if (ran.length) logger.info({ ran }, "migrations applied");
      await server.listen({ host: "0.0.0.0", port: config.port });
      relay?.start();
      logger.info({ role: config.role, port: config.port, relay: relay?.owner }, "started");
    },
    async stop() {
      await relay?.stop();
      await server.close();
      await pool.end();
    },
  };
}
