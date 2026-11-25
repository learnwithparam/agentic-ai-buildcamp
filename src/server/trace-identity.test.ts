import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";

// Lesson 11. The trace is the third place a doctor's details can leak. It records who asked by
// id, company and country, and never the name or email. The question is one the lesson 10
// door refuses, so no model is called.
process.env.OPENAI_API_KEY ||= "not-used-by-this-test";
const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
after(() => sdk.shutdown());
const { runMedinfoTurn } = await import("./medinfo-agent");
const { executeTool } = await import("./tools");
type Identity = import("./users").Identity;

const user: Identity = { userId: "kc-okafor", name: "Chidi Okafor", email: "chidi.okafor@pharma-b.example.com", tenantId: "pharma_b", country: "US", roles: [] };

async function recorded() {
  // The SDK finishes reading its resource attributes before it hands spans over.
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  exporter.reset();
  assert.ok(spans.length > 0, "no spans were recorded");
  const text = JSON.stringify(spans.map((span) => span.attributes));
  assert.ok(!text.includes(user.email), "a span holds the doctor's email");
  assert.ok(!text.includes(user.name), "a span holds the doctor's name");
  return { spans, text };
}

test("a chat turn's trace names the company and country, not the doctor's name or email", async () => {
  await runMedinfoTurn(
    { threadId: crypto.randomUUID(), user, messages: [{ id: "q", type: "human", content: "Write a Python script to scrape clinicaltrials.gov" }] },
    () => {}
  );
  const { spans, text } = await recorded();
  const root = spans.find((span) => span.name === "hcp-medinfo-chat-turn")!;
  assert.equal(root.attributes["user.id"] ?? root.attributes["langfuse.user.id"], "kc-okafor");
  assert.match(text, /pharma_b/);
});

test("a tool span names the company and country it answered for, not the doctor", async () => {
  await executeTool("approval_status", { medicine: "NeuroVex", country: "US" }, user);
  const { spans } = await recorded();
  const tool = spans.find((span) => span.name === "approval_status")!;
  // Lesson 16: the span also names the day the labels were read for, so a trace shows which label was in force.
  assert.deepEqual(JSON.parse(String(tool.attributes["langfuse.observation.input"])), {
    medicine: "NeuroVex",
    country: "US",
    asker: { tenantId: "pharma_b", country: "US" },
    today: "2026-11-23"
  });
});

// Not every step runs above (the tools node, search_labels), so this holds every traced step to
// the same rule: Langfuse records only what the step chooses to record.
test("every traced step that is handed the doctor turns off automatic input capture", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["./medinfo-agent.ts", "./tools.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const options = [...source.matchAll(/\{ name(?:: "[^"]+")?, asType: "[^"]+"[^}]*\}/g)].map((match) => match[0]);
    assert.ok(options.length >= 2, `${file}: found ${options.length} traced steps`);
    for (const option of options) assert.match(option, /captureInput: false/, `${file}: ${option}`);
  }
});
