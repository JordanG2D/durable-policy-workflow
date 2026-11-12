import type { APIGatewayProxyEventV2, Context, SQSEvent } from "aws-lambda";
import { migrate } from "../db/migrate.js";
import { createHttpHandler } from "./http.js";
import { publishDue } from "./queue.js";
import { emitOutboxLag } from "./metrics.js";
import { runtime } from "./runtime.js";

export async function api(event: APIGatewayProxyEventV2, context: Context) {
  context.callbackWaitsForEmptyEventLoop = false;
  return createHttpHandler((await runtime()).server)(event);
}
export async function publisher(_event: unknown, context: Context) {
  context.callbackWaitsForEmptyEventLoop = false;
  const app = await runtime();
  const lag = await app.pool.query<{ seconds: number }>(
    `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::float8 AS seconds
     FROM outbox WHERE status = 'pending'`);
  emitOutboxLag(Number(lag.rows[0]?.seconds ?? 0));
  return { published: await publishDue(app.pool, app.queue, app.queueUrl) };
}
export async function worker(event: SQSEvent, context: Context) {
  context.callbackWaitsForEmptyEventLoop = false;
  return (await runtime()).worker(event);
}
/** Invoked explicitly by deployment, never on ordinary API/worker requests. */
export async function migration(_event: unknown, context: Context) {
  context.callbackWaitsForEmptyEventLoop = false;
  return { applied: await migrate((await runtime()).pool) };
}
