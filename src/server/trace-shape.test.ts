import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";

// Fix 6. Each span records what its step was given, not the whole graph state. With the state
// as input, the router's own question sat at the end of one long block and nobody could see
// what each step worked from. The question below is one the lesson 10 door refuses, so no
// model is called.
process.env.OPENAI_API_KEY ||= "not-used-by-this-test";
const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
after(() => sdk.shutdown());
const { runMedinfoTurn } = await import("./medinfo-agent");
const { routerInput } = await import("./tiers");
type ChatMessage = import("../shared/messages").ChatMessage;

test("the router span records the router's own input: the latest message, with earlier turns as context", async () => {
  const messages: ChatMessage[] = [
    { id: "a", type: "human", content: "What is the CardioNex dose for eGFR 24?" },
    { id: "b", type: "ai", content: [{ type: "text", text: "5 mg once daily [cardionex-uspi-v2, 2.2]" }], tool_calls: [] },
    { id: "c", type: "human", content: "Write a Python script to scrape clinicaltrials.gov" }
  ];
  const user = { userId: "kc-rivera", name: "Ana Rivera", email: "ana.rivera@pharma-a.example.com", tenantId: "pharma_a", country: "US", roles: [] };
  await runMedinfoTurn({ threadId: crypto.randomUUID(), user, messages }, () => {});
  await processor.forceFlush();
  const router = exporter.getFinishedSpans().find((span) => span.name === "router");
  assert.ok(router, "no router span was recorded");
  assert.equal(router.attributes["langfuse.observation.input"], routerInput(messages));
});

// The other steps call the model, so this holds their source to the same rule: no span input is
// the bare state or turn.
test("no traced step records the whole graph state as its input", () => {
  const source = readFileSync(new URL("./medinfo-agent.ts", import.meta.url), "utf8");
  const inputs = [...source.matchAll(/updateActiveObservation\(\{ input: ([^\n]+?) \}\);/g)].map((match) => match[1]);
  assert.ok(inputs.length >= 5, `found ${inputs.length} span inputs`);
  for (const input of inputs) assert.doesNotMatch(input, /^(state|turn)$/, `a span records ${input} whole`);
});
