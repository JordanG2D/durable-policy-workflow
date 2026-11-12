import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { crashHookFromEnv } from "./faults/crash.js";
import { initTracing, shutdownTracing } from "./observability/tracing.js";

const config = loadConfig();
initTracing({ serviceName: `policy-workflow-${config.role}`, otlpEndpoint: config.otlpEndpoint });

const app = createApp(config, { crash: crashHookFromEnv() });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.logger.info({ signal }, "shutting down");
  // A hard deadline: anything still in flight is safe to abandon, because its
  // lease will expire and another worker will pick it up.
  setTimeout(() => process.exit(1), 10_000).unref();
  void app
    .stop()
    .then(shutdownTracing)
    .then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await app.start();
