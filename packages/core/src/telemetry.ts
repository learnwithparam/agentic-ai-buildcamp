// Tracing. Every step an agent takes becomes a span, and spans nest into one trace.
// Phoenix shows the trace. The tenant and the agent name ride on every span.
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const PHOENIX_URL = process.env.PHOENIX_URL ?? "http://localhost:6006";
export const PROJECT = "buildcamp";

export type Tags = { tenantId: string; agentName: string; person?: string };
export type Attributes = Record<string, string | number | boolean>;

let provider: BasicTracerProvider | undefined;

function startTracing(): BasicTracerProvider {
  if (provider !== undefined) return provider;
  // A child span needs this to find its parent. Without it, each span starts a new trace.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const exporter = new OTLPTraceExporter({ url: `${PHOENIX_URL}/v1/traces` });
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "openinference.project.name": PROJECT }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return provider;
}

// #region step:gateway-tracing
export async function traced<Result>(
  name: string,
  tags: Tags,
  work: (setAttributes: (extra: Attributes) => void) => Promise<Result>,
  kind = "CHAIN",
): Promise<Result> {
  const tracer = startTracing().getTracer("buildcamp");
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes({
      "openinference.span.kind": kind,
      tenant_id: tags.tenantId,
      agent_name: tags.agentName,
    });
    try {
      return await work((extra) => span.setAttributes(extra));
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
// #stub
//~ // TODO(gateway-tracing): open a span, add the tags, run the work, end the span
//~ export async function traced<Result>(
//~   _name: string,
//~   _tags: Tags,
//~   work: (setAttributes: (extra: Attributes) => void) => Promise<Result>,
//~   _kind = "CHAIN",
//~ ): Promise<Result> {
//~   return work(() => {});
//~ }
// #endregion

export async function flushTraces(): Promise<void> {
  await provider?.forceFlush();
}

// The id of the span that is running now, so a check can find its own trace.
export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
