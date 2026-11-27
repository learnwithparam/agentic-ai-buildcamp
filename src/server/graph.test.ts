import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { aiText, type AiMessage, type ChatMessage } from "../shared/messages";
import { buildGraph, fixedReply, reportNotice, reportStep, reviewStep, runGraph, submitAdverseEvent, submitDraftStep, type ReviewSubmission } from "./graph";
import type { Route, Tier } from "./tiers";
import { scriptUser } from "./users";

// Lesson 13. The tiers' wiring, with a fake router and a fake agent: no model calls. Each tier
// must reach its own path, and only the review tier may wait for a human.

const draft: AiMessage = { id: "draft", type: "ai", content: [{ type: "text", text: "Give 5mg once daily." }], tool_calls: [] };

function routedGraph(tier: Tier, visited: string[], report?: Route["report"]) {
  const route: Route = { tier, reason: "test", asksForAdvice: false, report };
  const seen = (name: string) => visited.push(name);
  return buildGraph(
    {
      router: () => (seen("router"), { route }),
      agent: () => (seen("agent"), { messages: [draft] }),
      tools: () => (seen("tools"), {}),
      cite: () => (seen("cite"), {}),
      submit: (state, config) => (seen("submit"), submitDraftStep(state, config, "trace-1")),
      review: (state, config) => (seen("review"), reviewStep(state, config)),
      report: (state, config) => (seen("report"), reportStep(state, config, "CASE DRAFT", "trace-1")),
      safety: async (state, config) => (seen("safety"), await submitAdverseEvent(state, config, "PV_ESCALATION", "trace-1"), fixedReply(state, "PV_ESCALATION")),
      stop: (state) => (seen("stop"), fixedReply(state, "OFF_LABEL_REFUSAL"))
    },
    new MemorySaver()
  );
}

function fakeInbox() {
  const items: ReviewSubmission[] = [];
  return { items, submit: async (item: ReviewSubmission) => (items.push(item), { dueAt: new Date("2026-11-27T09:00:00Z"), status: "waiting" as const }) };
}

const ask = (content: string): ChatMessage[] => [{ id: "q", type: "human", content }];
const lastText = (messages: ChatMessage[]) => aiText(messages.filter((message): message is AiMessage => message.type === "ai").at(-1)!);

for (const [tier, path, waits, kinds] of [
  ["answer", ["router", "agent", "cite"], false, []],
  ["review", ["router", "agent", "cite", "submit", "review"], true, ["draft"]],
  ["safety", ["router", "safety"], false, ["adverse_event"]],
  ["stop", ["router", "stop"], false, []]
] as const) {
  test(`the ${tier} tier runs ${path.join(" -> ")}`, async () => {
    const visited: string[] = [];
    const inbox = fakeInbox();
    const result = await runGraph(routedGraph(tier, visited), { threadId: `t-${tier}`, user: scriptUser(), inbox, messages: ask("A question") }, () => {});
    assert.deepEqual(visited, path);
    assert.equal(result.waitingForApproval, waits);
    assert.deepEqual(inbox.items.map((item) => item.kind), kinds);
    // The dataset run's risk_tier score reads the tier from here.
    assert.equal(result.route?.tier, tier);
    // A safety reviewer reads the desk's reply next to the doctor's words, not the words twice.
    if (tier === "safety") assert.deepEqual([inbox.items[0].question, inbox.items[0].body], ["A question", "PV_ESCALATION"]);
  });
}

test("a draft is stamped in code and goes to the inbox once, however often its node runs", async () => {
  const visited: string[] = [];
  const inbox = fakeInbox();
  const graph = routedGraph("review", visited);
  const turn = { threadId: "t-stamp", user: scriptUser(), inbox };
  const paused = await runGraph(graph, { ...turn, messages: ask("Draft a reply to Dr. Lee") }, () => {});
  assert.equal(lastText(paused.messages), "REVIEW_REQUIRED\n\nGive 5mg once daily.");
  assert.equal(inbox.items[0].body, "REVIEW_REQUIRED\n\nGive 5mg once daily.");
  assert.equal(inbox.items[0].traceId, "trace-1");

  const resumed = await runGraph(graph, { ...turn, resume: { itemId: inbox.items[0].id, decision: "approve" } }, () => {});
  assert.equal(resumed.waitingForApproval, false);
  assert.equal(lastText(resumed.messages), "A medical reviewer approved this draft. It is ready to send.");
  // The submit node does not run again on resume; the review node does, and writes nothing.
  assert.equal(new Set(inbox.items.map((item) => item.id)).size, 1);
});

test("a script run with no inbox still pauses and returns the stamped draft", async () => {
  const result = await runGraph(routedGraph("review", []), { threadId: "t-script", user: scriptUser(), messages: ask("Draft a reply") }, () => {});
  assert.equal(result.waitingForApproval, true);
  assert.match(lastText(result.messages), /^REVIEW_REQUIRED/);
});

test("a decision for another draft does not release the one that waits", async () => {
  const inbox = fakeInbox();
  const graph = routedGraph("review", []);
  const turn = { threadId: "t-other", user: scriptUser(), inbox };
  await runGraph(graph, { ...turn, messages: ask("Draft a reply to Dr. Lee") }, () => {});
  await assert.rejects(runGraph(graph, { ...turn, resume: { itemId: "draft-t-other-an-older-draft", decision: "approve" } }, () => {}), /not for draft-t-other-draft/);
  const state = await graph.getState({ configurable: { thread_id: "t-other" } });
  assert.equal(state.tasks.flatMap((task) => task.interrupts).length, 1);
});

test("a turn with no tier stops instead of answering", async () => {
  const graph = buildGraph(
    {
      router: () => ({}),
      agent: () => ({ messages: [draft] }),
      tools: () => ({}),
      cite: () => ({}),
      submit: () => ({}),
      report: () => ({}),
      review: () => ({}),
      safety: () => ({}),
      stop: () => ({})
    },
    new MemorySaver()
  );
  await assert.rejects(runGraph(graph, { threadId: "t-none", user: scriptUser(), messages: ask("A question") }, () => {}), /no tier/);
});

// Issue #122. A pregnancy exposure with nothing wrong: the doctor gets the checked answer, with one
// sentence saying a report was opened, and the safety inbox gets the case. One answer message, not two.
test("a special situation with no harm is answered and reported", async () => {
  const visited: string[] = [];
  const inbox = fakeInbox();
  const result = await runGraph(routedGraph("answer", visited, "pregnancy_exposure"), { threadId: "t-report", user: scriptUser(), inbox, messages: ask("She is 9 weeks pregnant on CardioNex. Should she stay on it?") }, () => {});
  assert.deepEqual(visited, ["router", "agent", "cite", "report"]);
  assert.deepEqual(inbox.items.map((item) => item.kind), ["adverse_event"]);
  assert.equal(result.waitingForApproval, false);
  assert.equal(result.route?.tier, "answer");
  const answers = result.messages.filter((message): message is AiMessage => message.type === "ai");
  assert.equal(answers.length, 1);
  assert.equal(lastText(result.messages), `Give 5mg once daily.\n\n${reportNotice("pregnancy_exposure")}`);
  assert.match(inbox.items[0].body, /exposure in pregnancy[\s\S]*CASE DRAFT/);
});
