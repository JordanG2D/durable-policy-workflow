import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, bundleWorkflowCode, type WorkflowBundle, type WorkflowBundleOption } from "@temporalio/worker";
import { createActivities, type ActivityDeps } from "./activities.js";
import { activityInterceptors, workflowInterceptorModules, workflowSpanSinks } from "./tracing.js";

const runningFromSource = import.meta.url.endsWith(".ts");

/**
 * Bundle the workflow code (webpack) once. Workers in the same process can
 * share the bundle; production workers can load one prebuilt at build time.
 */
export async function bundleWorkflows(): Promise<WorkflowBundle> {
  const workflowsPath = fileURLToPath(new URL(`./workflows.${runningFromSource ? "ts" : "js"}`, import.meta.url));
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    workflowInterceptorModules,
    logger: { info() {}, warn: console.warn, error: console.error, debug() {}, trace() {}, log() {} },
    webpackConfigHook: (config) => {
      config.resolve ??= {};
      // ESM sources import siblings as "./x.js"; resolve those to the .ts files when bundling from source.
      config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
      // Workspace packages expose their TypeScript sources under the "source" condition.
      if (runningFromSource) config.resolve.conditionNames = ["source", "import", "require", "default"];
      return config;
    },
  });
  return { code };
}

export interface CreateWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace?: string;
  readonly taskQueue: string;
  readonly workflowBundle: WorkflowBundleOption;
  readonly activities: ActivityDeps;
  readonly identity?: string;
  /**
   * How long a workflow task waits on this worker's sticky queue before going
   * to the shared queue. Low values make recovery from a dead worker faster.
   */
  readonly stickyQueueScheduleToStartTimeoutMs?: number;
  /** Workflow cache size; 0 disables caching and sticky queues (every task replays from history). */
  readonly maxCachedWorkflows?: number;
}

export function createWorker(opts: CreateWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: opts.connection,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    taskQueue: opts.taskQueue,
    workflowBundle: opts.workflowBundle,
    activities: createActivities(opts.activities),
    interceptors: { activity: activityInterceptors() },
    sinks: workflowSpanSinks(),
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.maxCachedWorkflows !== undefined ? { maxCachedWorkflows: opts.maxCachedWorkflows } : {}),
    ...(opts.stickyQueueScheduleToStartTimeoutMs
      ? { stickyQueueScheduleToStartTimeout: opts.stickyQueueScheduleToStartTimeoutMs }
      : {}),
  });
}
