/**
 * OpenTelemetry for the Temporal implementation, using Temporal's own
 * interceptors (@temporalio/interceptors-opentelemetry):
 *
 *   client  StartWorkflow / SignalWorkflow / QueryWorkflow spans, and the
 *           trace context is written into the workflow's headers;
 *   workflow RunWorkflow / StartActivity / HandleSignal spans, created inside
 *           the sandbox and exported through a sink;
 *   activity RunActivity spans, children of the workflow's StartActivity.
 *
 * Inside each activity, @policy/domain's `inSpan` adds the same `step <name>`
 * and provider spans the hand-built version emits, so one workflow is one
 * trace with the same span names in both implementations.
 */
import { createRequire } from "node:module";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
  OpenTelemetryWorkflowClientInterceptor,
  makeWorkflowExporter,
} from "@temporalio/interceptors-opentelemetry";
import type { InjectedSinks, WorkerInterceptors } from "@temporalio/worker";
import { registeredSpanProcessors } from "@policy/domain/tracing";

const require = createRequire(import.meta.url);

/** Workflow interceptor module, compiled into the workflow bundle. */
export const workflowInterceptorModules = [
  require.resolve("@temporalio/interceptors-opentelemetry/lib/workflow-interceptors"),
];

export const clientInterceptors = () => ({ workflow: [new OpenTelemetryWorkflowClientInterceptor()] });

export const activityInterceptors = (): WorkerInterceptors["activity"] => [
  (ctx) => ({
    inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
    outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
  }),
];

/**
 * Sink that receives finished workflow spans from the sandbox and hands them
 * to the processors registered by `initTracing`.
 */
export function workflowSpanSinks(): InjectedSinks<Record<string, never>> {
  const { processors, resource } = registeredSpanProcessors();
  const forward = new LegacySpanAdapter(processors);
  // The interceptors package is built against OTel SDK 1.x types; the shapes it needs are compatible.
  return { exporter: makeWorkflowExporter(forward as never, resource as never) } as never;
}

/**
 * The workflow sandbox's tracer is OTel SDK 1.x, which names two fields
 * differently from the 2.x SDK the rest of this repo uses. Translate before
 * handing the span to a 2.x processor or exporter.
 */
class LegacySpanAdapter implements SpanProcessor {
  constructor(private readonly targets: readonly SpanProcessor[]) {}

  onStart(_span: Span, _ctx: OtelContext): void {}

  onEnd(span: ReadableSpan): void {
    const legacy = span as ReadableSpan & {
      parentSpanId?: string;
      instrumentationLibrary?: ReadableSpan["instrumentationScope"];
    };
    const translated: ReadableSpan = {
      ...legacy,
      spanContext: () => span.spanContext(),
      parentSpanContext:
        legacy.parentSpanContext ??
        (legacy.parentSpanId
          ? { traceId: span.spanContext().traceId, spanId: legacy.parentSpanId, traceFlags: span.spanContext().traceFlags }
          : undefined),
      instrumentationScope: legacy.instrumentationScope ?? legacy.instrumentationLibrary ?? { name: "temporal-workflow" },
    };
    for (const t of this.targets) t.onEnd(translated);
  }

  forceFlush(): Promise<void> {
    return Promise.all(this.targets.map((t) => t.forceFlush())).then(() => undefined);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
