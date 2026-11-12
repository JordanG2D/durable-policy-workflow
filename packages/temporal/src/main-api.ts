/** HTTP API process for the Temporal implementation. */
import { Client, Connection } from "@temporalio/client";
import { createLogger } from "@policy/domain/logger";
import { initTracing, shutdownTracing } from "@policy/domain/tracing";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { clientInterceptors } from "./tracing.js";

const config = loadConfig();
initTracing({ serviceName: "policy-workflow-temporal-api", otlpEndpoint: config.otlpEndpoint });
const log = createLogger(config.logLevel);

const connection = await Connection.connect({ address: config.temporalAddress });
const client = new Client({ connection, namespace: config.namespace, interceptors: clientInterceptors() });
const app = buildApi({
  client,
  taskQueue: config.taskQueue,
  log,
  ...(config.workflowConfig ? { workflowConfig: config.workflowConfig } : {}),
});

const shutdown = () => {
  setTimeout(() => process.exit(1), 10_000).unref();
  void app
    .close()
    .then(() => connection.close())
    .then(shutdownTracing)
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: config.port });
