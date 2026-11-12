/** Temporal worker process: runs workflow tasks and activities for the policy-issuance task queue. */
import { NativeConnection } from "@temporalio/worker";
import { httpDocumentGateway, httpPaymentGateway, httpPolicyGateway } from "@policy/domain/clients/gateways";
import { crashHookFromEnv } from "@policy/domain/crash";
import { rulePricing } from "@policy/domain/pricing";
import { initTracing, shutdownTracing } from "@policy/domain/tracing";
import { loadConfig } from "./config.js";
import { bundleWorkflows, createWorker } from "./worker.js";

const config = loadConfig();
initTracing({ serviceName: "policy-workflow-temporal-worker", otlpEndpoint: config.otlpEndpoint });

const connection = await NativeConnection.connect({ address: config.temporalAddress });
const timeout = config.externalCallTimeoutMs;
const worker = await createWorker({
  connection,
  namespace: config.namespace,
  taskQueue: config.taskQueue,
  workflowBundle: config.workflowBundlePath ? { codePath: config.workflowBundlePath } : await bundleWorkflows(),
  activities: {
    pricing: rulePricing,
    payments: httpPaymentGateway(config.paymentProviderUrl, timeout),
    policies: httpPolicyGateway(config.policyRegistryUrl, timeout),
    documents: httpDocumentGateway(config.documentServiceUrl, timeout),
    paymentCallbackUrl: config.paymentCallbackUrl,
    crash: crashHookFromEnv(),
  },
  stickyQueueScheduleToStartTimeoutMs: 2_000,
  heartbeatThrottleMs: 1_000,
  ...(config.maxCachedWorkflows !== undefined ? { maxCachedWorkflows: config.maxCachedWorkflows } : {}),
});

// SIGTERM/SIGINT: the SDK stops polling, lets in-flight tasks finish, then run() resolves.
console.log(JSON.stringify({ level: "info", msg: "worker running", taskQueue: config.taskQueue }));
await worker.run();
await connection.close();
await shutdownTracing();
