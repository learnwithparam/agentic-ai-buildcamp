// The trace-to-hops mapping on the span shapes a real chat turn writes (the shapes of traces
// c0be2ae5 and f630aa7d, cut down to the fields the mapping reads).
import assert from "node:assert/strict";
import { test } from "node:test";
import { hopsOf, type Observation } from "./flows";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 23, 10, 0, 0, (clock += 100))).toISOString();
const span = (id: string, name: string, type: string, parent: string | null, input?: unknown, output?: unknown): Observation => {
  const startTime = at();
  return { id, name, type, parentObservationId: parent, startTime, endTime: at(), input: JSON.stringify(input), output: JSON.stringify(output) };
};
const turn = (question: string, reply: string) =>
  span("t", "hcp-medinfo-chat-turn", "AGENT", null, { messages: [{ type: "human", content: question }] }, { messages: [{ type: "human", content: question }, { type: "ai", content: [{ type: "text", text: reply }] }] });
const route = (tier: string) =>
  span("g", "route", "GENERATION", "r", {}, { tool_calls: [{ function: { name: "route", arguments: JSON.stringify({ tier, reason: `sorted as ${tier}` }) } }] });

test("a stopped question goes from the router straight to the reply, with no tool", () => {
  const flow = hopsOf([turn("Dose for a 9-year-old?", "OFF_LABEL_REFUSAL\n\nNot on the label."), span("r", "router", "CHAIN", "t", "Message to sort"), route("stop")]);
  assert.equal(flow.tier, "stop");
  assert.equal(flow.q, "Dose for a 9-year-old?");
  assert.deepEqual(flow.hops.map((h) => `${h.from}>${h.to}`), ["turn>router", "router>model", "router>reply"]);
  assert.equal(flow.hops[2].out, "OFF_LABEL_REFUSAL\nNot on the label.");
});

test("an answered question walks the agent, each tool, the citation check and the reply in order", () => {
  const flow = hopsOf([
    turn("Dose for eGFR 24?", "**5 mg** once daily [cardionex-uspi-v2, 2.2]"),
    span("r", "router", "CHAIN", "t", "Message to sort"),
    route("answer"),
    span("a1", "agent", "SPAN", "t", { tools: ["search_labels", "read_section"] }),
    span("m1", "OpenAI.chat", "GENERATION", "a1", {}, { tool_calls: [{ function: { name: "search_labels", arguments: '{"query":"eGFR 24"}' } }] }),
    span("s", "search_labels", "TOOL", "x", { query: "eGFR 24" }, { ok: true, results: [{ doc_id: "cardionex-uspi-v2", section: "2.2", score: 0.7561 }] }),
    span("rd", "read_section", "TOOL", "x", { doc_id: "cardionex-uspi-v2", section: "2.2" }, { ok: true, found: true, title: "Dosing", status: "active", text: "long" }),
    span("a2", "agent", "SPAN", "t"),
    span("m2", "OpenAI.chat", "GENERATION", "a2", {}, "**5 mg** once daily [cardionex-uspi-v2, 2.2]"),
    span("c", "cite", "SPAN", "t", { sections: ["cardionex-uspi-v2 2.2"] }, { outcome: "passed" }),
  ]);
  assert.deepEqual(flow.hops.map((h) => `${h.from}>${h.to}`), [
    "turn>router", "router>model", "router>agent", "agent>model", "agent>search", "agent>read", "agent>model", "agent>cite", "cite>reply",
  ]);
  assert.equal(flow.hops[2].out, "The question and 2 tools: search_labels, read_section");
  assert.equal(flow.hops[4].out, "cardionex-uspi-v2 2.2  0.756");
  assert.equal(flow.hops[5].out, '{"found":true,"title":"Dosing","status":"active"}');
  assert.equal(flow.hops[6].out, "5 mg once daily [cardionex-uspi-v2, 2.2]");
  assert.ok(flow.hops.every((h) => typeof h.ms === "number" || h.ms === undefined));
});

test("a trace that is not a chat turn is refused, not drawn as an empty path", () => {
  assert.throws(() => hopsOf([span("x", "experiment-item-run", "SPAN", null)]), /not one chat turn/);
});
