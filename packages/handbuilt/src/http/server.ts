import { createHash, randomUUID } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { withTransaction, type Pool } from "../db/pool.js";
import { isMigrated } from "../db/migrate.js";
import { Industries, type PolicyApplication } from "@policy/domain/pricing";
import type { Logger } from "@policy/domain/logger";
import type { Metrics } from "../observability/metrics.js";
import { traceParentOf, tracer } from "@policy/domain/tracing";
import { getWorkflow, insertWorkflow, listTransitions } from "../workflow/repository.js";
import { confirmPayment } from "../workflow/steps.js";

export interface ServerDeps {
  readonly pool: Pool;
  readonly log: Logger;
  readonly metrics: Metrics;
  /** Extra readiness condition, e.g. "the relay loop is running" in worker processes. */
  readonly isWorkerHealthy?: () => boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const applicationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["businessName", "industry", "annualRevenueCents", "employeeCount", "contactEmail"],
  properties: {
    businessName: { type: "string", minLength: 1, maxLength: 200 },
    industry: { type: "string", enum: [...Industries] },
    annualRevenueCents: { type: "integer", minimum: 0, maximum: 100_000_000_000 },
    employeeCount: { type: "integer", minimum: 0, maximum: 10_000 },
    contactEmail: { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" },
  },
} as const;

const paymentCallbackSchema = {
  type: "object",
  required: ["eventId", "type", "chargeId", "reference"],
  properties: {
    eventId: { type: "string", minLength: 1, maxLength: 200 },
    type: { type: "string" },
    chargeId: { type: "string", minLength: 1, maxLength: 200 },
    reference: { type: "string" },
  },
} as const;

/** Stable hash of the request body, so "same key, different request" can be detected. */
function requestHash(body: PolicyApplication): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { pool, metrics } = deps;
  // Widen to Fastify's logger interface so the instance type matches FastifyInstance.
  const baseLogger: FastifyBaseLogger = deps.log;
  const app = Fastify({
    loggerInstance: baseLogger,
    // The correlation id is the request id: taken from the caller if supplied,
    // stored on the workflow, and attached to every log line about it.
    genReqId: (req) => {
      const supplied = req.headers["x-correlation-id"];
      return typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128 ? supplied : randomUUID();
    },
    requestIdLogLabel: "correlationId",
    disableRequestLogging: false,
  });

  app.addHook("onSend", async (req, reply) => {
    void reply.header("x-correlation-id", req.id);
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      checks.database = (await pool.query("SELECT 1")).rowCount === 1;
      checks.migrations = await isMigrated(pool);
    } catch {
      checks.database = false;
    }
    if (deps.isWorkerHealthy) checks.worker = deps.isWorkerHealthy();
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });

  app.get("/metrics", async (_req, reply) => {
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  app.post<{ Body: PolicyApplication }>(
    "/v1/policy-applications",
    { schema: { body: applicationSchema } },
    async (req, reply) => {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 200) {
        return reply.code(400).send({ error: "idempotency_key_required", detail: "send an Idempotency-Key header (8-200 chars)" });
      }
      const hash = requestHash(req.body);
      const workflowId = randomUUID();
      const parent = propagation.extract(ROOT_CONTEXT, req.headers);

      // The key and the workflow are created in the same transaction. A
      // concurrent request with the same key blocks on the primary key until
      // this one commits, then takes the replay branch.
      const result = await withTransaction(pool, async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, hash],
        );
        if (inserted.rowCount === 0) {
          const { rows } = await tx.query<{ request_hash: string; response_status: number; response_body: unknown }>(
            "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1",
            [key],
          );
          const stored = rows[0]!;
          if (stored.request_hash !== hash) return { kind: "conflict" as const };
          return { kind: "replay" as const, status: stored.response_status, body: stored.response_body };
        }

        // Root span of the workflow's trace. It ends with this request; later
        // steps attach to it through the stored traceparent.
        const span = tracer().startSpan(
          "workflow policy-issuance",
          { attributes: { "workflow.id": workflowId, "correlation.id": req.id } },
          parent,
        );
        try {
          const traceParent = traceParentOf(trace.setSpan(context.active(), span));
          const wf = await insertWorkflow(tx, {
            id: workflowId,
            application: req.body,
            correlationId: req.id,
            traceParent,
          });
          const body = { workflowId: wf.id, state: wf.state, correlationId: wf.correlationId };
          await tx.query(
            `UPDATE idempotency_keys SET workflow_id = $2, response_status = 202, response_body = $3 WHERE key = $1`,
            [key, wf.id, JSON.stringify(body)],
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return { kind: "created" as const, status: 202, body };
        } finally {
          span.end();
        }
      });

      if (result.kind === "conflict") {
        return reply.code(422).send({
          error: "idempotency_key_reused",
          detail: "this Idempotency-Key was already used with a different request body",
        });
      }
      if (result.kind === "replay") {
        metrics.duplicatesSuppressed.inc({ kind: "request" });
        req.log.info({ idempotencyKey: key }, "idempotent replay");
        return reply.code(result.status).header("idempotent-replayed", "true").send(result.body);
      }
      metrics.workflowsStarted.inc();
      req.log.info({ workflowId, idempotencyKey: key }, "workflow started");
      return reply.code(result.status).header("location", `/v1/policy-applications/${workflowId}`).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/policy-applications/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const wf = await getWorkflow(pool, req.params.id);
    if (!wf) return reply.code(404).send({ error: "not_found" });
    return {
      workflowId: wf.id,
      state: wf.state,
      premiumCents: wf.premiumCents,
      paymentChargeId: wf.paymentChargeId,
      policyNumber: wf.policyNumber,
      documentDeliveryId: wf.documentDeliveryId,
      deadLetterReason: wf.deadLetterReason,
      correlationId: wf.correlationId,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      transitions: await listTransitions(pool, wf.id),
    };
  });

  /**
   * Asynchronous payment confirmation from the provider. Providers deliver
   * these at least once, so the event id is recorded in the same transaction
   * as its effect; a repeat is acknowledged and ignored.
   * (A real integration would also verify an HMAC signature; see README.)
   */
  app.post<{ Body: { eventId: string; type: string; chargeId: string; reference: string } }>(
    "/webhooks/payments",
    { schema: { body: paymentCallbackSchema } },
    async (req, reply) => {
      const { eventId, type, chargeId, reference } = req.body;
      const outcome = await withTransaction(pool, async (tx) => {
        const fresh = await tx.query(
          `INSERT INTO inbound_events (source, event_id, workflow_id, outcome)
           VALUES ('payments', $1, $2, 'received') ON CONFLICT DO NOTHING RETURNING event_id`,
          [eventId, UUID_RE.test(reference) ? reference : null],
        );
        if (fresh.rowCount === 0) return "duplicate";
        let result: string;
        if (type !== "charge.succeeded") result = "ignored-type";
        else if (!UUID_RE.test(reference) || !(await getWorkflow(tx, reference))) result = "unknown-workflow";
        else result = await confirmPayment(tx, { log: deps.log.child({ correlationId: req.id }), metrics }, { workflowId: reference, chargeId, cause: "payment-callback" });
        await tx.query(`UPDATE inbound_events SET outcome = $2 WHERE source = 'payments' AND event_id = $1`, [eventId, result]);
        return result;
      });
      if (outcome === "duplicate") metrics.duplicatesSuppressed.inc({ kind: "payment-callback" });
      req.log.info({ eventId, workflowId: reference, outcome }, "payment callback handled");
      return reply.send({ received: true, outcome });
    },
  );

  return app;
}
