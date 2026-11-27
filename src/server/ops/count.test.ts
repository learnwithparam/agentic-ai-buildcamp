import assert from "node:assert/strict";
import { test } from "node:test";

// The count of a turn's model calls, and what each stage of a turn took. No model runs here: the
// global fetch is the wire, and it sends back the bytes a gateway would send. Every module under
// test reaches the wire through modelClient() in src/server/gateway.ts.
process.env.GATEWAY_KEY_EVAL_RUNNER = "test-key";
process.env.LANGFUSE_GATEWAY_URL = "http://gateway.test";

const { measureTurn, timed } = await import("./meter");
const { modelClient, useService, embed, OUTPUT_CAP } = await import("../gateway");
const { standaloneQuery } = await import("../rag/rewrite");
const { gradePassages } = await import("../rag/grade");
const { extractClaims } = await import("../citations.claims");
const { toolsStep } = await import("../graph");

useService("eval-runner");

type Sent = { url: string; body: Record<string, unknown> };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  sent.push({ url: String(url), body });
  if (String(url).endsWith("/embeddings")) return json({ data: [{ index: 0, embedding: new Array(1536).fill(0) }], usage: { prompt_tokens: 1, cost: 0.0001 } });
  const format = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
  const content = format === "grades" ? '{"grades":[3],"best":[1]}' : format === "claims" ? '{"claims":[]}' : "What is the dose?";
  return json({ choices: [{ message: { role: "assistant", content } }], usage: { cost: 0.002 } });
}) as typeof fetch;
test.after(() => void (globalThis.fetch = realFetch));

const passage = { source: "doc", path: "1.1", text: "Start at 20 mg." };

test("a call made through modelClient by any module is counted, with its cost", async () => {
  let seen: Awaited<ReturnType<typeof measureTurn>> | undefined;
  let metrics: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  await measureTurn(
    async () => {
      await modelClient().chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] });
      await standaloneQuery("and for renal?", [{ role: "user", content: "CardioNex dose?" }]);
      await gradePassages("dose?", [passage]);
      await extractClaims(modelClient(), "Start at 20 mg.", [{ doc_id: "d", section: "1.1", text: "Start at 20 mg." } as never]);
      await embed(["dose"]);
    },
    (m) => void (metrics = m)
  );
  seen = undefined;
  assert.equal(seen, undefined);
  assert.equal(metrics!.calls, 5);
  assert.equal(metrics!.callsWithoutCost, 0);
  assert.ok(Math.abs(metrics!.costUsd - (4 * 0.002 + 0.0001)) < 1e-9);
});

test("a turn inside a turn adds its calls to the turn around it", async () => {
  let outer: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  let inner: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  await measureTurn(
    () => measureTurn(() => modelClient().chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] }), (m) => void (inner = m)),
    (m) => void (outer = m)
  );
  assert.equal(inner!.calls, 1);
  assert.equal(outer!.calls, 1, "the outer turn saw no call: the inner meter hid it (the real run counted 0 calls)");
  assert.ok(outer!.costUsd > 0);
});

test("each stage a turn runs is timed, and the outer turn keeps the inner turn's stages", async () => {
  let outer: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  await measureTurn(
    () => measureTurn(async () => { await timed("router", () => new Promise((r) => setTimeout(r, 20))); await timed("answer", async () => 1); }, () => {}),
    (m) => void (outer = m)
  );
  assert.deepEqual(outer!.stages.map((s) => s.stage), ["router", "answer"]);
  assert.ok(outer!.stages[0]!.seconds >= 0.015);
  assert.equal(await timed("router", async () => 7), 7, "outside a turn it only runs the work");
});

test("a stage that throws is still timed", async () => {
  let metrics: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  await assert.rejects(
    measureTurn(() => timed("answer", async () => { throw new Error("boom"); }), (m) => void (metrics = m)),
    /boom/
  );
  assert.deepEqual(metrics!.stages.map((s) => s.stage), ["answer"]);
});

test("the tools of one model message run at the same time and keep the order of the calls", async () => {
  const call = (id: string, name: string) => ({ id, name, args: {} });
  const state = { messages: [{ id: "a", type: "ai", content: [], tool_calls: [call("1", "slow"), call("2", "fast")] }] } as never;
  const started = performance.now();
  const update = await toolsStep(state, async (name) => {
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, name };
  });
  assert.ok(performance.now() - started < 200, "the two tools ran one after another");
  assert.deepEqual((update.messages as Array<{ tool_call_id: string; name: string }>).map((m) => m.tool_call_id), ["1", "2"]);
  assert.equal((update.messages as Array<{ content: string }>)[0]!.content, JSON.stringify({ ok: true, name: "slow" }));
});

test("a stage that needs a short answer asks the model for a short answer", async () => {
  sent.length = 0;
  await standaloneQuery("and for renal?", [{ role: "user", content: "CardioNex dose?" }]);
  await gradePassages("dose?", [passage]);
  await extractClaims(modelClient(), "Start at 20 mg.", [{ doc_id: "d", section: "1.1", text: "Start at 20 mg." } as never]);
  const caps = sent.map((s) => s.body.max_tokens ?? s.body.max_completion_tokens);
  // Each sends its own cap from OUTPUT_CAP. The claims list is as long as the answer, so its cap is
  // the largest: it only stops a runaway listing.
  assert.deepEqual(caps, [OUTPUT_CAP.rewrite, OUTPUT_CAP.grade, OUTPUT_CAP.claims]);
  assert.ok(OUTPUT_CAP.claims >= Math.max(OUTPUT_CAP.rewrite, OUTPUT_CAP.grade));
});

test("an answer with no words has no claims, and no model is asked", async () => {
  sent.length = 0;
  assert.deepEqual(await extractClaims(modelClient(), "   ", [{ doc_id: "d", section: "1.1", text: "x" } as never]), []);
  assert.equal(sent.length, 0);
});
