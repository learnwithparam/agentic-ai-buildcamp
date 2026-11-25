/**
 * For the live tests (npm run check:live): the real model, through the gateway, traced as in the app.
 *
 * Every span goes to Langfuse, so each live run can be opened there, and to memory, so a test can
 * count the model calls and read what each one was sent. The count comes from the app's own
 * observeOpenAI generations, not from a wrapper around the client.
 *
 * Import this first in a *.live.ts file, before anything that imports the model client.
 */
import "../src/server/load-env";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";

const memory = new tracing.InMemorySpanExporter();
const inMemory = new tracing.SimpleSpanProcessor(memory);
const langfuse = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [inMemory, langfuse] });
sdk.start();

export type Generation = { name: string; input: string; traceId: string };

// The model calls since the last reset, oldest first. name is the generationName the code gave.
export async function generations(name?: string): Promise<Generation[]> {
  await inMemory.forceFlush();
  return memory
    .getFinishedSpans()
    .filter((span) => span.attributes["langfuse.observation.type"] === "generation")
    .map((span) => ({ name: span.name, input: String(span.attributes["langfuse.observation.input"] ?? ""), traceId: span.spanContext().traceId }))
    .filter((generation) => !name || generation.name === name);
}

export const spans = async () => (await inMemory.forceFlush(), memory.getFinishedSpans());
export const resetSpans = () => memory.reset();

export async function stopTracing() {
  await langfuse.forceFlush();
  await sdk.shutdown();
}
