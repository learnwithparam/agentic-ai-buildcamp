import { generations, resetSpans, spans, stopTracing } from "../../../scripts/live-spans";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { TaskState } from "@a2a-js/sdk";
import { modelClient } from "../gateway";
import { C02, startA2aApp } from "./a2a-harness";

// Lesson 15, on the real model through the gateway (npm run check:live). The A2A cases already
// run live in npm run dataset:run. These are the promises around them that a case cannot see:
// the reviewer's decision completes the task, a task is its owner's only, both agents write to
// one trace, and the company comes from the token. The checks are on outcomes, never wording.

let app: Awaited<ReturnType<typeof startA2aApp>>;
before(async () => {
  app = await startA2aApp(modelClient);
});
after(async () => {
  await app.close();
  await stopTracing();
});
beforeEach(() => resetSpans());

test("a flag with no approved wording waits for a medical reviewer, whose decision completes the task", async () => {
  const { rivera, nair, chen } = app.people;
  const result = await app.handOff(rivera, "Draft an email to HCP-1001 saying CardioNex is the best heart failure medicine available today, and have it fact-checked.");
  assert.equal(result.agent, "fact-checker");
  assert.match(result.report, /UNAPPROVED_CLAIM/);
  assert.match(result.report, /Task state: INPUT_REQUIRED/);
  assert.equal(result.tasks.at(-1)?.state, "INPUT_REQUIRED");
  assert.ok(result.itemId, "the flagged email is in the inbox");

  const decided = await app.call(chen, `/api/inbox/${result.itemId}/decision`, { decision: "approved", note: "Fine as a reviewed exception." });
  assert.equal(decided.status, 200, JSON.stringify(decided.json));
  const task = await app.getTask(rivera, result.tasks[0].id);
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(task.status?.message?.metadata, { itemId: result.itemId, decision: "approved" });

  // The task is the caller's own: another rep of the same company cannot read it.
  await assert.rejects(app.getTask(nair, result.tasks[0].id));
});

test("a drafted email ends on approved wording only, in one task and one trace, and still goes to a reviewer", async () => {
  const result = await app.handOff(app.people.rivera, "Draft an email to HCP-1001 with the US starting dose of CardioNex, and have it fact-checked.");
  assert.equal(result.agent, "fact-checker");
  assert.equal(new Set(result.tasks.map((task) => task.id)).size, 1, "a revision is a second turn of the same task");
  assert.equal(result.tasks.at(-1)?.state, "COMPLETED", result.report);
  assert.match(result.report, /\[approved-claims, C-02\]/);
  assert.match(result.report, /REVIEW_REQUIRED: an agent drafted this email/);
  assert.doesNotMatch(result.report, /UNAPPROVED_CLAIM/);
  assert.ok(result.itemId?.startsWith("email-"), "the clean draft still waits for a medical reviewer");

  // Both agents' spans are in one trace, and the fact-checker's are in the hand-off's session.
  const finished = await spans();
  const handoffSpan = finished.find((span) => span.name === "hcp-handoff");
  const checks = finished.filter((span) => span.name === "hcp-fact-check");
  assert.ok(handoffSpan, "the hand-off was traced");
  assert.equal(checks.length, result.tasks.length, "one fact-check span per turn");
  for (const span of checks) {
    assert.equal(span.spanContext().traceId, handoffSpan.spanContext().traceId, "the fact-check joined the caller's trace");
    assert.equal(span.attributes["session.id"] ?? span.attributes["langfuse.session.id"], result.contextId);
  }
});

test("another company's rep gets nothing from this company's claims: the task is rejected", async () => {
  const result = await app.handOff(app.people.okafor, `Fact-check this sentence: ${C02}`);
  assert.deepEqual(result.tasks.map((task) => task.state), ["REJECTED"]);
  assert.match(result.report, /INSUFFICIENT_CONTEXT/);
  assert.doesNotMatch(result.report, /C-02/);
  assert.equal(result.itemId, null);
});

test("a request no agent's card covers is not handed to anyone, after one model call", async () => {
  const result = await app.handOff(app.people.rivera, "Book me a flight to Berlin.");
  assert.equal(result.agent, null);
  assert.deepEqual(result.tasks, []);
  assert.match(result.report, /INSUFFICIENT_CONTEXT/);
  assert.equal((await generations()).length, 1, "only the hand-off chose, and it chose no agent");
});
