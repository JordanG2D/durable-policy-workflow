import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { FastifyInstance } from "fastify";

/** HTTP API payload 2.0, preserving the existing Fastify routes and validation. */
export function createHttpHandler(server: FastifyInstance) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    await server.ready();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(event.headers)) if (value !== undefined) headers[key] = value;
    if (event.cookies?.length) headers.cookie = event.cookies.join("; ");
    const response = await server.inject({
      method: event.requestContext.http.method,
      url: event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ""),
      headers,
      ...(event.body !== undefined ? { payload: Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") } : {}),
      remoteAddress: event.requestContext.http.sourceIp,
    });
    const outgoing: Record<string, string> = {};
    const cookies: string[] = [];
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined || key === "transfer-encoding") continue;
      if (key === "set-cookie") cookies.push(...(Array.isArray(value) ? value : [String(value)]));
      else outgoing[key] = Array.isArray(value) ? value.join(",") : String(value);
    }
    return { statusCode: response.statusCode, headers: outgoing, cookies, body: response.rawPayload.toString("base64"), isBase64Encoded: true };
  };
}
