import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { measureTurn, meteredFetch, readJsonCall, readStreamCall, asksForStructure } from "./meter";
import { scoreTurn } from "./metrics";
import { PINNED_DAY, resolveToday } from "./today";
import { TODAY } from "../labels";

// Lesson 23. No model call, no database: the date rule, the meter's reading of a model answer,
// and the scores a turn sends.

test("without an override, today is the real day in UTC", () => {
  assert.equal(resolveToday({}, new Date("2027-03-04T23:59:59Z")), "2027-03-04");
  assert.equal(resolveToday({ MEDINFO_TODAY: "" }, new Date("2027-03-04T01:00:00Z")), "2027-03-04");
});

test("MEDINFO_TODAY pins the day, and only a real day is taken", () => {
  assert.equal(resolveToday({ MEDINFO_TODAY: PINNED_DAY }, new Date("2030-01-01T00:00:00Z")), PINNED_DAY);
  for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "26-11-23"]) {
    assert.throws(() => resolveToday({ MEDINFO_TODAY: bad }), /MEDINFO_TODAY/);
  }
});

test("the labels' TODAY follows the environment this test runs in", () => {
  assert.equal(TODAY, resolveToday());
  if (process.env.MEDINFO_TODAY) assert.equal(TODAY, process.env.MEDINFO_TODAY);
});

test("the scripts that read stored answers or the dataset run on the pinned day", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  for (const name of ["dataset:run", "release:gate", "judge:calibrate", "citations:audit", "citations:replay", "check", "check:live", "ops:measure"]) {
    assert.match(scripts[name]!, new RegExp(`MEDINFO_TODAY=\\$\\{MEDINFO_TODAY:-${PINNED_DAY}\\}`), name);
  }
  assert.match(readFileSync(".githooks/pre-push", "utf8"), new RegExp(`MEDINFO_TODAY="\\$\\{MEDINFO_TODAY:-${PINNED_DAY}\\}"`));
});

test("a request for structure is told from an ordinary one", () => {
  assert.equal(asksForStructure({ response_format: { type: "json_schema" } }), "json");
  assert.equal(asksForStructure({ tool_choice: { type: "function", function: { name: "route" } } }), "tool");
  assert.equal(asksForStructure({ tool_choice: "required" }), "tool");
  assert.equal(asksForStructure({ tool_choice: "auto", tools: [] }), null);
  assert.equal(asksForStructure({ messages: [] }), null);
});

test("an answer is read for its cost and for whether its JSON parses", () => {
  const good = { usage: { cost: 0.002 }, choices: [{ message: { content: '{"grades":[]}' } }] };
  assert.deepEqual(readJsonCall("json", good), { cost: 0.002, structured: true, parsed: true });
  assert.equal(readJsonCall("json", { choices: [{ message: { content: '{"grades":[' } }] }).parsed, false);
  assert.equal(readJsonCall("json", { choices: [{ message: { content: "" } }] }).cost, null);

  const forced = (args: string) => ({ choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] });
  assert.equal(readJsonCall("tool", forced('{"tier":"answer"}')).parsed, true);
  assert.equal(readJsonCall("tool", forced('{"tier":')).parsed, false);
  // A forced tool call that came back as plain text is a failure too.
  assert.equal(readJsonCall("tool", { choices: [{ message: { content: "answer" } }] }).parsed, false);
  // Nothing was asked for, so nothing can fail.
  assert.deepEqual(readJsonCall(null, { choices: [{ message: { content: "hello" } }] }), { cost: null, structured: false, parsed: true });
});

test("a streamed answer is joined before it is judged", () => {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const text =
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }) +
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }) +
    chunk({ choices: [], usage: { cost: 0.01 } }) +
    "data: [DONE]\n\n";
  assert.deepEqual(readStreamCall("tool", text), { cost: 0.01, structured: true, parsed: true });
  assert.equal(readStreamCall("tool", text.replace("1}", "1")).parsed, false);
});

test("a turn's model calls are summed through the gateway's fetch, and nothing is counted outside a turn", async () => {
  const answer = (cost: number, content: string) =>
    new Response(JSON.stringify({ usage: { cost }, choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
  const replies = [answer(0.01, "{}"), answer(0.02, "{bad"), answer(0.03, "{}")];
  // The wrapped fetch is the transport, not a model: the answers above are the bytes a gateway sends.
  const send = meteredFetch(async () => replies.shift()!);
  const structured = JSON.stringify({ response_format: { type: "json_schema" } });
  await send("http://gateway/chat", { method: "POST", body: "{}" });
  assert.equal(replies.length, 2, "a call outside a turn still gets its answer");

  let seen: Parameters<Parameters<typeof measureTurn>[1]>[0] | undefined;
  const body = await measureTurn(
    async () => {
      const first = await send("http://gateway/chat", { method: "POST", body: structured });
      await send("http://gateway/chat", { method: "POST", body: structured });
      return first.json();
    },
    (metrics) => void (seen = metrics)
  );
  assert.equal((body as { usage: { cost: number } }).usage.cost, 0.02, "the caller reads the body the gateway sent");
  assert.equal(seen?.calls, 2);
  assert.equal(seen?.structuredCalls, 2);
  assert.equal(seen?.parseFailures, 1);
  assert.equal(seen?.callsWithoutCost, 0);
  assert.ok(Math.abs((seen?.costUsd ?? 0) - 0.05) < 1e-9);
});

test("a turn's numbers become scores on its trace, and a turn with an unpriced call gets no cost", () => {
  const sent: Array<{ traceId: string; name: string; value: number; dataType: string }> = [];
  const langfuse = { score: { create: (score: (typeof sent)[number]) => void sent.push(score), flush: async () => {} } };
  const metrics = { seconds: 12.3456, calls: 3, costUsd: 0.0123456789, callsWithoutCost: 0, structuredCalls: 2, parseFailures: 1, stages: [] };
  scoreTurn(langfuse, "trace-1", metrics);
  assert.deepEqual(
    sent.map(({ name, value }) => [name, value]),
    [
      ["latency_seconds", 12.35],
      ["cost_usd", 0.012346],
      ["parse_failures", 1]
    ]
  );
  assert.ok(sent.every((score) => score.traceId === "trace-1" && score.dataType === "NUMERIC"));
  sent.length = 0;
  scoreTurn(langfuse, "trace-2", { ...metrics, callsWithoutCost: 1 });
  assert.deepEqual(sent.map((score) => score.name), ["latency_seconds", "parse_failures"]);
  sent.length = 0;
  scoreTurn(langfuse, undefined, metrics);
  assert.deepEqual(sent, []);
});
