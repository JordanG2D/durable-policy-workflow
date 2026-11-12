/**
 * HTTP API for the Temporal implementation. Same routes, request schemas and
 * response shapes as the hand-built API, so the same clients, smoke script and
 * parity suite work against both.
 *
 * Where the hand-built API needs Postgres tables, this one leans on Temporal:
 * - Idempotency-Key: the workflow id is derived from the key and the server
 *   rejects a second start with the same id (WorkflowIdReusePolicy
 *   REJECT_DUPLICATE). The request hash lives in the workflow's memo.
 * - Reads: a query against the workflow, not a SELECT.
 * - Payment callbacks: a signal. The workflow itself recognises repeats.
 */
import { createHash, randomUUID } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from "@temporalio/client";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "@policy/domain/logger";
import type { PolicyApplication } from "@policy/domain/pricing";
import { applicationSchema, paymentCallbackSchema, requestHash } from "@policy/domain/schemas";
import { WORKFLOW_SPAN_NAME } from "@policy/domain/steps";
import { tracer } from "@policy/domain/tracing";
import { paymentConfirmedSignal, stateQuery, type PolicySnapshot, type PolicyWorkflowConfig } from "./definitions.js";
import type { policyIssuance } from "./workflows.js";

export interface ApiDeps {
  readonly client: Client;
  readonly taskQueue: string;
  readonly log: Logger;
  /** Passed to every workflow started by this API (retry policies, timeouts). */
  readonly workflowConfig?: PolicyWorkflowConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable, UUID-shaped workflow id for an Idempotency-Key. */
export function workflowIdForKey(key: string): string {
  const h = createHash("sha256").update(`policy-application:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface Memo {
  requestHash?: string;
  correlationId?: string;
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const { client } = deps;
  const baseLogger: FastifyBaseLogger = deps.log;
  const app = Fastify({
    loggerInstance: baseLogger,
    genReqId: (req) => {
      const supplied = req.headers["x-correlation-id"];
      return typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128 ? supplied : randomUUID();
    },
    requestIdLogLabel: "correlationId",
  });

  app.addHook("onSend", async (req, reply) => {
    void reply.header("x-correlation-id", req.id);
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const temporal = await client.workflowService.getSystemInfo({}).then(
      () => true,
      () => false,
    );
    return reply.code(temporal ? 200 : 503).send({ status: temporal ? "ready" : "not-ready", checks: { temporal } });
  });

  app.post<{ Body: PolicyApplication }>(
    "/v1/policy-applications",
    { schema: { body: applicationSchema } },
    async (req, reply) => {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 200) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_required", detail: "send an Idempotency-Key header (8-200 chars)" });
      }
      const hash = requestHash(req.body);
      const workflowId = workflowIdForKey(key);
      const parent = propagation.extract(ROOT_CONTEXT, req.headers);

      // Root span of the workflow's trace. The client interceptor copies its
      // context into the workflow's headers; every later span descends from it.
      const span = tracer().startSpan(
        WORKFLOW_SPAN_NAME,
        { attributes: { "workflow.id": workflowId, "correlation.id": req.id } },
        parent,
      );
      try {
        await context.with(trace.setSpan(parent, span), () =>
          client.workflow.start<typeof policyIssuance>("policyIssuance", {
            taskQueue: deps.taskQueue,
            workflowId,
            workflowIdReusePolicy: "REJECT_DUPLICATE",
            args: [
              { application: req.body, correlationId: req.id, ...(deps.workflowConfig ? { config: deps.workflowConfig } : {}) },
            ],
            memo: { requestHash: hash, correlationId: req.id } satisfies Memo,
          }),
        );
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        }
        // Same key again: replay the original response, or refuse a different body.
        const memo = ((await client.workflow.getHandle(workflowId).describe()).memo ?? {}) as Memo;
        if (memo.requestHash !== hash) {
          return reply.code(422).send({
            error: "idempotency_key_reused",
            detail: "this Idempotency-Key was already used with a different request body",
          });
        }
        req.log.info({ idempotencyKey: key, workflowId }, "idempotent replay");
        return reply
          .code(202)
          .header("idempotent-replayed", "true")
          .send({ workflowId, state: "QUOTE_REQUESTED", correlationId: memo.correlationId ?? req.id });
      } finally {
        span.end();
      }
      req.log.info({ workflowId, idempotencyKey: key }, "workflow started");
      return reply
        .code(202)
        .header("location", `/v1/policy-applications/${workflowId}`)
        .send({ workflowId, state: "QUOTE_REQUESTED", correlationId: req.id });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/policy-applications/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    let s: PolicySnapshot;
    try {
      s = await client.workflow.getHandle(req.params.id).query(stateQuery);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return reply.code(404).send({ error: "not_found" });
      throw err;
    }
    return {
      workflowId: s.workflowId,
      state: s.state,
      premiumCents: s.premiumCents,
      paymentChargeId: s.paymentChargeId,
      policyNumber: s.policyNumber,
      documentDeliveryId: s.documentDeliveryId,
      deadLetterReason: s.deadLetterReason,
      correlationId: s.correlationId,
      transitions: s.transitions,
      duplicateSignals: s.duplicateSignals,
      anomalies: s.anomalies,
    };
  });

  /**
   * Asynchronous payment confirmation from the provider, delivered at least
   * once. It becomes a signal; the workflow recognises repeats by event id
   * and by state. (A real integration would verify an HMAC signature first.)
   */
  app.post<{ Body: { eventId: string; type: string; chargeId: string; reference: string } }>(
    "/webhooks/payments",
    { schema: { body: paymentCallbackSchema } },
    async (req, reply) => {
      const { eventId, type, chargeId, reference } = req.body;
      let outcome: string;
      if (type !== "charge.succeeded") outcome = "ignored-type";
      else if (!UUID_RE.test(reference)) outcome = "unknown-workflow";
      else {
        const handle = client.workflow.getHandle(reference);
        try {
          await handle.signal(paymentConfirmedSignal, { eventId, chargeId });
          outcome = "signalled";
        } catch (err) {
          if (!(err instanceof WorkflowNotFoundError)) throw err;
          // Either no such workflow, or it has already closed (completed, or
          // dead-lettered and past its late-capture window).
          outcome = (await exists(client, reference)) ? "workflow-closed" : "unknown-workflow";
          if (outcome === "workflow-closed") {
            req.log.error({ workflowId: reference, chargeId }, "payment captured for a closed workflow; manual review required");
          }
        }
      }
      req.log.info({ eventId, workflowId: reference, outcome }, "payment callback handled");
      return reply.send({ received: true, outcome });
    },
  );

  return app;
}

async function exists(client: Client, workflowId: string): Promise<boolean> {
  try {
    await client.workflow.getHandle(workflowId).describe();
    return true;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return false;
    throw err;
  }
}
