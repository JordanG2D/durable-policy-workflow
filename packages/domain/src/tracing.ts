import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * Tracing model: a workflow is one trace. The API creates a root span and
 * stores its W3C `traceparent` on the workflow and on every outbox row. Each
 * step, whichever worker process runs it and however much later, starts its
 * span as a child of that stored context, so the whole workflow (including
 * retries and recovery after a crash) shows up as a single trace.
 */

let provider: NodeTracerProvider | undefined;
let processors: SpanProcessor[] = [];
let resource: Resource | undefined;

export function initTracing(opts: {
  serviceName: string;
  otlpEndpoint?: string | undefined;
  exporter?: SpanExporter;
}): void {
  if (provider) return;
  const spanProcessors: SpanProcessor[] = [];
  if (opts.exporter) spanProcessors.push(new SimpleSpanProcessor(opts.exporter));
  if (opts.otlpEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${opts.otlpEndpoint.replace(/\/$/, "")}/v1/traces` }),
      ),
    );
  }
  processors = spanProcessors;
  resource = resourceFromAttributes({ "service.name": opts.serviceName });
  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register({ propagator: new W3CTraceContextPropagator() });
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
  processors = [];
  resource = undefined;
}

/**
 * The span processors and resource registered by `initTracing`, for spans
 * that are created outside the global tracer provider and handed over already
 * finished (Temporal exports workflow-sandbox spans this way).
 */
export function registeredSpanProcessors(): { processors: readonly SpanProcessor[]; resource: Resource | undefined } {
  return { processors, resource };
}

export const tracer = () => trace.getTracer("policy-workflow");

export function traceParentOf(ctx: Context = context.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent;
}

export function contextFromTraceParent(traceParent: string | null | undefined): Context {
  if (!traceParent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, { traceparent: traceParent });
}

/** Headers to forward the active trace to a downstream HTTP service. */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Run `fn` in a span; record exceptions and set status; always end the span. */
export async function inSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
