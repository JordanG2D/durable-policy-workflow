import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { APIGatewayProxyEventV2, SQSEvent } from "aws-lambda";
import type { Pool } from "../../src/db/pool.js";
import type { ClaimedEvent } from "../../src/outbox/outbox.js";
import { createHttpHandler } from "../../src/aws/http.js";
import { claimEvent, createQueueWorker, parseEnvelope, publishDue } from "../../src/aws/queue.js";

const id = "69b04d26-8cf6-403e-9fa9-1f1e59248aa8";
const body = JSON.stringify({ version: 1, kind: "outbox", eventId: id });
function event(...bodies: string[]): SQSEvent {
  return { Records: bodies.map((value, i) => ({ messageId: String(i), body: value })) } as SQSEvent;
}

describe("AWS outbox transport", () => {
  it("validates envelopes and rejects injected poison", () => {
    expect(parseEnvelope(body)).toBe(id);
    for (const value of ['null', '{}', '{', JSON.stringify({ version: 1, kind: "poison", eventId: id })]) {
      expect(() => parseEnvelope(value)).toThrow();
    }
  });
  it("publishes only event IDs and does not consume leases or attempts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ event_id: id }] });
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await publishDue({ query } as unknown as Pool, { send }, "queue")).toBe(1);
    expect(send).toHaveBeenCalledWith("queue", body);
    expect(query.mock.calls[0]![0]).not.toMatch(/UPDATE|INSERT/);
    expect(query.mock.calls[0]![0]).toContain("available_at <= now()");
  });
  it("does not hide a failed publication", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ event_id: id }] }) } as unknown as Pool;
    await expect(publishDue(pool, { send: async () => { throw new Error("unavailable"); } }, "q")).rejects.toThrow();
  });
  it("atomically fences a specific due event", async () => {
    const query = vi.fn<(sql: string, args: unknown[]) => Promise<{ rows: ClaimedEvent[] }>>().mockResolvedValue({ rows: [] });
    expect(await claimEvent({ query } as unknown as Pool, id, 15000)).toBeUndefined();
    expect(query.mock.calls[0]![0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[0]![0]).toContain("attempts = o.attempts + 1");
    expect(query.mock.calls[0]![1][0]).toBe(id);
  });
  it("acknowledges stale/duplicate/backoff copies without executing steps", async () => {
    const processClaim = vi.fn();
    const run = createQueueWorker({ claim: async () => undefined, relay: { processClaim } });
    expect(await run(event(body, body))).toEqual({ batchItemFailures: [] });
    expect(processClaim).not.toHaveBeenCalled();
  });
  it("reports only poison or failed records, allowing successful batch peers", async () => {
    const claim = { eventId: id } as ClaimedEvent;
    const processClaim = vi.fn().mockResolvedValue(undefined);
    const run = createQueueWorker({ claim: async () => claim, relay: { processClaim } });
    expect(await run(event(body, '{"kind":"poison"}'))).toEqual({ batchItemFailures: [{ itemIdentifier: "1" }] });
    expect(processClaim).toHaveBeenCalledOnce();
    processClaim.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await run(event(body))).toEqual({ batchItemFailures: [{ itemIdentifier: "0" }] });
  });
});

it("bridges HTTP API v2 request bodies, query, cookies and binary responses", async () => {
  const server = Fastify();
  server.post("/echo", async (req, reply) => reply.header("set-cookie", ["a=1", "b=2"]).send({
    body: req.body, query: req.query, cookie: req.headers.cookie,
  }));
  try {
    const result = await createHttpHandler(server)({
      headers: { "content-type": "application/json" }, cookies: ["token=synthetic"],
      rawPath: "/echo", rawQueryString: "a=hello%20world", isBase64Encoded: true,
      body: Buffer.from('{"test":true}').toString("base64"),
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
    } as unknown as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(200);
    expect(result.cookies).toEqual(["a=1", "b=2"]);
    expect(JSON.parse(Buffer.from(result.body!, "base64").toString())).toEqual({
      body: { test: true }, query: { a: "hello world" }, cookie: "token=synthetic",
    });
  } finally { await server.close(); }
});

it("emits newline-delimited top-level EMF without a Lambda console wrapper", async () => {
  const { emitOutboxLag } = await import("../../src/aws/metrics.js");
  const now = vi.spyOn(Date, "now").mockReturnValue(123456789);
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    emitOutboxLag(123);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const line = write.mock.calls[0]![0];
    expect(typeof line).toBe("string");
    expect(String(line).endsWith("\n")).toBe(true);
    expect(JSON.parse(String(line))).toEqual({
      _aws: { Timestamp: 123456789, CloudWatchMetrics: [{ Namespace: "PolicyDemo",
        Dimensions: [["Service"]], Metrics: [{ Name: "OutboxLagSeconds", Unit: "Seconds" }],
      }] }, Service: "handbuilt", OutboxLagSeconds: 123,
    });
  } finally { write.mockRestore(); consoleLog.mockRestore(); now.mockRestore(); }
});
