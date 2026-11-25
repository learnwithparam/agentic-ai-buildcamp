import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { aiText, type AiMessage } from "../shared/messages";
import { createPool } from "./db";
import { env } from "./env";
import { buildGraph, fixedReply, readThread, reviewStep, runGraph, submitDraftStep } from "./graph";
import { scriptUser } from "./users";

// Lesson 13. A restart is a new process with a new graph object. The only thing the two share is
// where the checkpoints live. Here a second graph resumes a draft the first one paused.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const SCHEMA = "langgraph_test";
before(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});
after(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

const draft: AiMessage = { id: "draft", type: "ai", content: [{ type: "text", text: "Give 5mg once daily." }], tool_calls: [] };

// A fresh graph each call, the way a restarted server builds one.
function serverGraph(checkpointer: BaseCheckpointSaver) {
  return buildGraph(
    {
      router: () => ({ route: { tier: "review", reason: "test", asksForAdvice: false } }),
      agent: () => ({ messages: [draft] }),
      tools: () => ({}),
      cite: () => ({}),
      submit: (state, config) => submitDraftStep(state, config),
      review: reviewStep,
      safety: (state) => fixedReply(state, ""),
      stop: (state) => fixedReply(state, "")
    },
    checkpointer
  );
}

async function pauseThenRestart(before: BaseCheckpointSaver, afterRestart: BaseCheckpointSaver) {
  const threadId = crypto.randomUUID();
  const turn = { threadId, user: scriptUser() };
  const paused = await runGraph(serverGraph(before), { ...turn, messages: [{ id: "q", type: "human", content: "Draft a reply to Dr. Lee" }] }, () => {});
  assert.equal(paused.waitingForApproval, true);
  const restarted = serverGraph(afterRestart);
  const waiting = await readThread(restarted, threadId);
  const resumed = await runGraph(restarted, { ...turn, resume: { itemId: (waiting.interrupts[0]?.value as { itemId?: string } | undefined)?.itemId ?? "none", decision: "approve" } }, () => {});
  return { waiting, resumed };
}

test("a draft paused before a restart is still waiting after it, and resumes", async () => {
  const saver = () => new PostgresSaver(pool, undefined, { schema: SCHEMA });
  const first = saver();
  await first.setup();
  const { waiting, resumed } = await pauseThenRestart(first, saver());
  assert.equal(waiting.interrupts.length, 1);
  assert.equal((waiting.interrupts[0].value as { kind: string }).kind, "approval");
  const note = resumed.messages.at(-1) as AiMessage;
  assert.equal(aiText(note), "A medical reviewer approved this draft. It is ready to send.");
});

// The control: the same steps with checkpoints in memory. The new process has an empty memory,
// so the thread is gone, and the resume has nothing to resume.
test("with checkpoints in memory, the restart loses the waiting draft", async () => {
  const { waiting, resumed } = await pauseThenRestart(new MemorySaver(), new MemorySaver());
  assert.equal(waiting.interrupts.length, 0);
  assert.equal(waiting.messages.length, 0);
  assert.ok(!resumed.messages.some((message) => message.type === "ai" && aiText(message).includes("approved")));
});
