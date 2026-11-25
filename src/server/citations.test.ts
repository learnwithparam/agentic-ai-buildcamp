import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type OpenAI from "openai";
import { MemorySaver } from "@langchain/langgraph";
import { aiText, type AiMessage, type ChatMessage } from "../shared/messages";
import { checkCitations, evidenceOf, parseCitations, quantities, WITHHELD_REPLY, type RetrievedSection } from "./citations";
import { buildGraph, citeStep, runGraph, type CitationOutcome } from "./graph";
import { scriptUser } from "./users";

// Lesson 21. The fixtures are four answers the agent really gave, read from Langfuse with the
// search results it had (citations.fixtures.json, trace ids inside). No model calls.
type Fixture = { trace: string; asked: string; answer: string; retrieved: RetrievedSection[] };
const fixtures = JSON.parse(readFileSync(new URL("./citations.fixtures.json", import.meta.url), "utf8")) as Record<string, Fixture>;
const check = (name: string) => {
  const { answer, retrieved, asked } = fixtures[name];
  return checkCitations(answer, retrieved, asked);
};

test("all three ways of writing a citation are read", () => {
  assert.deepEqual(parseCitations("Stop [cardionex-uspi-v2, 8.1]. Dose [cardionex-uspi-v2, 0.0; cardionex-de-smpc, 4.3] [neurovex-label, 2, 2026-09-15]"), [
    "cardionex-uspi-v2, 8.1",
    "cardionex-uspi-v2, 0.0",
    "cardionex-de-smpc, 4.3",
    "neurovex-label, 2"
  ]);
});

test("a dose reads the same however it is written", () => {
  assert.deepEqual([...quantities("Give **2.5 mg**, then 20-40mg after a 36-hour wait over 2 to 4 weeks")].sort(), ["2.5 mg", "20 mg", "36 hour", "4 week", "40 mg", "2 week"].sort());
});

test("the right answer to the nursing question passes", () => {
  assert.deepEqual(check("nursing-passes"), []);
});

test("an answer that cites the expired 2024 draft fails, even to say it is old", () => {
  assert.deepEqual(check("expired-draft"), [{ kind: "not_in_force", citation: "cardionex-draft-2024, 2.1", status: "expired" }]);
});

test("a dose with no citation fails", () => {
  assert.deepEqual(
    check("dose-without-citation").map((problem) => [problem.kind, "quantity" in problem && problem.quantity]),
    [["uncited", "5 mg"], ["uncited", "5 mg"]]
  );
});

test("a number cited to a section that does not state it fails", () => {
  const [problem] = check("number-from-another-section");
  assert.equal(problem.kind, "unsupported");
  assert.equal("quantity" in problem && problem.quantity, "40 %");
});

test("a citation to a section no search returned fails", () => {
  const { retrieved, asked } = fixtures["nursing-passes"];
  assert.deepEqual(checkCitations("Give 5 days [cardionex-uspi-v2, 8.2]. See also [cardionex-uspi-v2, 9.9].", retrieved, asked), [
    { kind: "not_retrieved", citation: "cardionex-uspi-v2, 9.9" }
  ]);
});

test("a number the doctor gave is a fact about the patient, not a claim to cite", () => {
  const { retrieved } = fixtures["nursing-passes"];
  const answer = "For her eGFR of 24 mL/min, breastfeeding is not recommended for 5 days after the last dose [cardionex-uspi-v2, 8.2].";
  assert.equal(checkCitations(answer, retrieved, "Her eGFR is 24 mL/min. Can she breastfeed?").length, 0);
  assert.equal(checkCitations(answer, retrieved, "Can she breastfeed?").length, 1);
});

test("a follow-up may cite what the first question's search found", () => {
  const search = (results: RetrievedSection[], id: string): ChatMessage => ({ id, type: "tool", tool_call_id: id, name: "search_labels", content: JSON.stringify({ ok: true, results }), status: "success" });
  const { retrieved } = fixtures["nursing-passes"];
  const messages: ChatMessage[] = [{ id: "q1", type: "human", content: "Nursing?" }, search(retrieved, "s1"), { id: "q2", type: "human", content: "How long after?" }];
  assert.deepEqual(evidenceOf(messages).retrieved.map((section) => section.section), retrieved.map((section) => section.section));
});

// --- The node. A fake model client streams one fixed reply per call and counts the calls.
function fakeModel(replies: string[]) {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);
          const text = replies[calls.length - 1] ?? "";
          return (async function* () {
            yield { choices: [{ delta: { content: text } }] };
          })();
        }
      }
    }
  } as unknown as OpenAI;
  return { client, calls };
}

function stateFor(name: string, answer = fixtures[name].answer) {
  const { retrieved, asked } = fixtures[name];
  const messages: ChatMessage[] = [
    { id: "q", type: "human", content: asked },
    { id: "tool-1", type: "tool", tool_call_id: "1", name: "search_labels", content: JSON.stringify({ ok: true, results: retrieved }), status: "success" },
    { id: "answer-1", type: "ai", content: [{ type: "text", text: answer }], tool_calls: [] }
  ];
  return { messages, route: null, dueAt: null, today: "2026-11-25" };
}

const run = async (name: string, replies: string[]) => {
  const model = fakeModel(replies);
  const outcomes: CitationOutcome[] = [];
  const update = await citeStep(model.client, "system", stateFor(name), {}, (result) => outcomes.push(result));
  return { model, outcome: outcomes[0], message: update.messages?.[0] as AiMessage | undefined };
};

test("an answer that passes goes out as written, with no model call", async () => {
  const { model, outcome, message } = await run("nursing-passes", []);
  assert.equal(model.calls.length, 0);
  assert.equal(outcome.outcome, "passed");
  assert.equal(message, undefined);
});

test("a failing answer is rewritten once, in place, with the problems spelled out", async () => {
  const fixed = "50 mg twice daily is not an approved regimen; the US dose is in [cardionex-uspi-v2, 2.2].";
  const { model, outcome, message } = await run("expired-draft", [fixed]);
  assert.equal(model.calls.length, 1);
  assert.match(JSON.stringify(model.calls[0]), /cardionex-draft-2024, 2\.1\] is expired/);
  assert.equal(outcome.outcome, "rewritten");
  assert.equal(message?.id, "answer-1");
  assert.equal(aiText(message!), fixed);
});

test("a rewrite that fails again is withheld, never sent", async () => {
  const { model, outcome, message } = await run("expired-draft", [fixtures["expired-draft"].answer]);
  assert.equal(model.calls.length, 1);
  assert.equal(outcome.outcome, "withheld");
  assert.equal(message?.id, "answer-1");
  assert.equal(aiText(message!), WITHHELD_REPLY);
});

// The wiring: every final answer, on the answer and the review tier, goes through cite.
for (const tier of ["answer", "review"] as const) {
  test(`on the ${tier} tier, the doctor and the reviewer only see the checked answer`, async () => {
    const visited: string[] = [];
    const graph = buildGraph(
      {
        router: () => ({ route: { tier, reason: "test", asksForAdvice: false } }),
        agent: () => ({ messages: [stateFor("expired-draft").messages[2]] }),
        tools: () => ({}),
        cite: () => (visited.push("cite"), { messages: [{ id: "answer-1", type: "ai", content: [{ type: "text", text: WITHHELD_REPLY }], tool_calls: [] }] }),
        submit: (state) => (visited.push(`submit:${aiText(state.messages.at(-1) as AiMessage)}`), {}),
        review: () => ({}),
        safety: () => ({}),
        stop: () => ({})
      },
      new MemorySaver()
    );
    const result = await runGraph(graph, { threadId: `cite-${tier}`, user: scriptUser(), messages: [{ id: "q", type: "human", content: "Was it approved at 50mg?" }] }, () => {});
    assert.deepEqual(visited, tier === "review" ? ["cite", `submit:${WITHHELD_REPLY}`] : ["cite"]);
    assert.equal(aiText(result.messages.at(-1) as AiMessage), WITHHELD_REPLY);
  });
}
