import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiMessage } from "../shared/messages";
import { buildGraph, reviewStep, runGraph } from "./graph";
import { scriptUser } from "./users";

const draft: AiMessage = { id: "draft", type: "ai", content: [{ type: "text", text: "Give 5mg once daily." }], tool_calls: [] };

test("a turn that pauses for review still returns the drafted messages", async () => {
  const graph = buildGraph({ agent: () => ({ messages: [draft] }), tools: () => ({}), review: reviewStep });
  const result = await runGraph(
    graph,
    { threadId: "review-pause", user: scriptUser(), messages: [{ id: "q", type: "human", content: "Draft a reply to Dr. Lee about CardioNex dosing." }] },
    () => {}
  );
  assert.equal(result.waitingForApproval, true);
  assert.deepEqual(result.messages.map((message) => message.id), ["q", "draft"]);
});
