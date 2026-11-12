import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/observability/logger.js";
import { priceQuote } from "../../src/domain/pricing.js";
import { sampleApplication } from "../helpers/db.js";
import {
  HAPPY_PATH,
  logSink,
  metricValue,
  spans,
  startHarness,
  startWorkflow,
  statesEntered,
  submitApplication,
  testConfig,
  waitFor,
  waitForState,
  type Harness,
} from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

describe("happy path", () => {
  it("runs a workflow end to end with one charge, one delivery and one trace", async () => {
    const workerLogs = logSink();
    const worker = await h.startWorker({}, { logger: workerLogs.logger });
    const res = await submitApplication(h.apiUrl, { correlationId: "corr-happy-path-1" });
    expect(res.status).toBe(202);
    expect(res.headers.get("x-correlation-id")).toBe("corr-happy-path-1");
    const id = res.body.workflowId as string;

    const wf = await waitForState(h.pool, id, "DOCUMENTS_DELIVERED");
    expect(wf.premiumCents).toBe(priceQuote(sampleApplication));
    expect(wf.policyNumber).toMatch(/^GL-\d{4}-\d+$/);
    expect(wf.correlationId).toBe("corr-happy-path-1");
    expect(await statesEntered(h.pool, id)).toEqual(HAPPY_PATH);

    // Side effects happened exactly once.
    expect(h.payment.capturesFor(id)).toBe(1);
    expect(h.payment.charges()[0]?.amountCents).toBe(wf.premiumCents);
    expect(h.documents.deliveriesFor(wf.policyNumber!)).toBe(1);

    // One trace: the API root span and every step span share a trace id.
    await waitFor(async () => spans.getFinishedSpans().some((s) => s.name === "step workflow.completed"));
    const finished = spans.getFinishedSpans();
    const root = finished.find((s) => s.name === "workflow policy-issuance");
    expect(root).toBeDefined();
    const traceId = root!.spanContext().traceId;
    const stepNames = finished.filter((s) => s.spanContext().traceId === traceId).map((s) => s.name);
    for (const step of ["quote.requested", "quote.priced", "policy.bound", "payment.confirmed", "policy.issued"]) {
      expect(stepNames).toContain(`step ${step}`);
    }
    expect(stepNames).toContain("payment.charge");
    expect(stepNames).toContain("documents.deliver");

    // Structured logs from the worker carry the correlation id.
    const transitioned = workerLogs.lines.filter((l) => l.msg === "workflow transitioned" && l.workflowId === id);
    expect(transitioned.length).toBe(5);
    for (const line of transitioned) expect(line.correlationId).toBe("corr-happy-path-1");

    expect(await metricValue(h.api, "workflows_started_total")).toBe(1);
    expect(await metricValue(worker, "workflows_completed_total")).toBe(1);
    expect(await metricValue(worker, "workflow_step_duration_seconds", { step: "policy.bound", outcome: "ok" })).toBeGreaterThan(0);
  });

  it("returns the workflow with its transition history", async () => {
    const id = await startWorkflow(h.apiUrl);
    const res = await fetch(`${h.apiUrl}/v1/policy-applications/${id}`);
    const body = (await res.json()) as { state: string; transitions: { to: string; cause: string }[] };
    expect(res.status).toBe(200);
    expect(body.state).toBe("QUOTE_REQUESTED");
    expect(body.transitions).toEqual([expect.objectContaining({ to: "QUOTE_REQUESTED", cause: "api" })]);
    expect((await fetch(`${h.apiUrl}/v1/policy-applications/not-a-uuid`)).status).toBe(404);
  });
});

describe("API idempotency", () => {
  it("replays the original response for a repeated key and creates nothing new", async () => {
    const first = await submitApplication(h.apiUrl, { key: "client-key-0001" });
    const second = await submitApplication(h.apiUrl, { key: "client-key-0001" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const { rows } = await h.pool.query("SELECT id FROM workflows");
    expect(rows).toHaveLength(1);
    expect(await metricValue(h.api, "duplicates_suppressed_total", { kind: "request" })).toBe(1);
  });

  it("rejects reuse of a key with a different request body", async () => {
    await submitApplication(h.apiUrl, { key: "client-key-0002" });
    const res = await submitApplication(h.apiUrl, {
      key: "client-key-0002",
      body: { ...sampleApplication, employeeCount: 99 },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("idempotency_key_reused");
    expect((await h.pool.query("SELECT id FROM workflows")).rows).toHaveLength(1);
  });

  it("creates exactly one workflow under 20 concurrent requests with the same key", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => submitApplication(h.apiUrl, { key: "client-key-burst" })),
    );
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(new Set(results.map((r) => r.body.workflowId)).size).toBe(1);
    expect((await h.pool.query("SELECT id FROM workflows")).rows).toHaveLength(1);
    expect((await h.pool.query("SELECT id FROM outbox")).rows).toHaveLength(1);
  });

  it("requires an idempotency key and a valid body", async () => {
    expect((await submitApplication(h.apiUrl, { key: "" })).status).toBe(400);
    expect((await submitApplication(h.apiUrl, { body: { ...sampleApplication, industry: "piracy" } })).status).toBe(400);
    expect((await submitApplication(h.apiUrl, { body: { businessName: "x" } })).status).toBe(400);
  });
});

describe("health and metrics endpoints", () => {
  it("serves /healthz, /readyz and Prometheus /metrics", async () => {
    expect((await fetch(`${h.apiUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${h.apiUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready", checks: { database: true, migrations: true } });

    await startWorkflow(h.apiUrl);
    const metrics = await fetch(`${h.apiUrl}/metrics`);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const text = await metrics.text();
    expect(text).toContain("workflows_started_total 1");
    expect(text).toMatch(/outbox_pending_events 1/);
    expect(text).toMatch(/outbox_lag_seconds \d/);
  });

  it("reports not-ready when the database is unreachable", async () => {
    const broken = createApp(testConfig({ role: "api", databaseUrl: "postgres://nobody:wrong@127.0.0.1:1/none" }), {
      logger: createLogger("silent"),
    });
    const res = await broken.server!.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not-ready", checks: { database: false } });
    expect((await broken.server!.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await broken.pool.end();
  });

  it("worker readiness includes the relay loop", async () => {
    const worker = await h.startWorker();
    const res = await worker.server!.inject({ method: "GET", url: "/readyz" });
    expect(res.json()).toMatchObject({ checks: { worker: true } });
  });
});
