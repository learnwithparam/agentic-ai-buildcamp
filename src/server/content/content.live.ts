import { generations, resetSpans, stopTracing } from "../../../scripts/live-spans";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createTestStore } from "../../../scripts/fga-model";
import { failedChecks, loadCases } from "../../../scripts/hcp-cases";
import { env } from "../env";
import { scriptUser } from "../users";
import { createFactChecker, readRequest } from "./fact-check";
import { createOutreachPlanner } from "./outreach";

// Lesson 14, on the real model through the gateway (npm run check:live). Every fact-check and
// outreach case runs through the real graph, and each run is a trace in Langfuse. The tests check
// the outcome the case promises, and how many model calls it took, never the model's wording.

if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

let client: Awaited<ReturnType<typeof createTestStore>>["client"];
before(async () => {
  client = (await createTestStore(env.fgaApiUrl, env.fgaApiToken)).client;
});
after(async () => {
  await client.deleteStore();
  await stopTracing();
});
beforeEach(() => resetSpans());

for (const item of loadCases("fact-check")) {
  test(`${item.metadata.caseId} passes its checks on the real model`, async () => {
    const check = createFactChecker({ client: () => client });
    const { report } = await check({ request: readRequest(item.input.messages[0].content), user: scriptUser(item.input.tenantId, item.input.country, ["sales-rep"]) });
    assert.deepEqual(failedChecks(report, item.expectedOutput.checks), [], report);
    // Only a sentence no claim matches costs a model call.
    assert.equal((await generations("suggest-claims")).length, /UNAPPROVED_CLAIM/.test(report) ? 1 : 0, report);
  });
}

test("a flagged email waits for a medical reviewer once, however often it is checked; an approved one does not", async () => {
  const items = new Map<string, string>();
  const inbox = { submit: async (item: { id: string; kind: string }) => (items.set(item.id, item.kind), { dueAt: new Date(), status: "waiting" as const }) };
  const check = createFactChecker({ client: () => client });
  const user = scriptUser("pharma_a", "US", ["sales-rep"]);
  const first = await check({ request: { draftId: "draft-email-us" }, user, inbox, threadId: "t-us" });
  const again = await check({ request: { draftId: "draft-email-us" }, user, inbox, threadId: "t-us-again" });
  assert.match(first.itemId ?? "", /^email-/);
  assert.equal(again.itemId, first.itemId);
  assert.equal(first.itemStatus, "waiting");
  assert.equal((await check({ request: { text: "Start CardioNex at 20mg once daily in adults with HFrEF.", country: "US" }, user, inbox, threadId: "t-ok" })).itemId, null);
  assert.deepEqual([...items.values()], ["email"]);
});

for (const item of loadCases("outreach")) {
  test(`${item.metadata.caseId} passes its checks on the real model`, async () => {
    const plan = createOutreachPlanner({ client: () => client });
    const { report } = await plan({ query: item.input.messages[0].content, user: scriptUser(item.input.tenantId, item.input.country, ["sales-rep"]) });
    assert.deepEqual(failedChecks(report, item.expectedOutput.checks), [], report);
    // A doctor the company cannot see is never shown to the model.
    assert.equal((await generations("propose-step")).length, report.startsWith("INSUFFICIENT_CONTEXT") ? 0 : 1, report);
  });
}
