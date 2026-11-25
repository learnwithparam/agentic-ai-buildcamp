import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type OpenAI from "openai";
import { createTestStore } from "../../../scripts/fga-model";
import { failedChecks, loadCases } from "../../../scripts/hcp-cases";
import { env } from "../env";
import { scriptUser } from "../users";
import { checkSentence, createFactChecker, readRequest } from "./fact-check";
import { createOutreachPlanner, planOutreach, readHcpId, type Proposal } from "./outreach";
import { CLAIMS, PROFILES, recordOf } from "./records";

// Lesson 14. The fact-checker and the outreach planner, against a real OpenFGA store made for the
// test and a stand-in model: no paid calls. The stand-in answers what a model would propose, so
// what is tested is the code around it: the verdicts, the holds, the citations and the tenancy.

if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

// A stand-in model that answers every call with one tool call, and counts the calls.
function standIn(name: string, args: (prompt: string) => unknown) {
  const calls: string[] = [];
  const model = {
    chat: {
      completions: {
        create: async (body: { messages: Array<{ content: string }> }) => {
          const prompt = body.messages.map((message) => message.content).join("\n");
          calls.push(prompt);
          return { choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args(prompt)) } }] } }] };
        }
      }
    }
  } as unknown as OpenAI;
  return { calls, model: () => model };
}

let client: Awaited<ReturnType<typeof createTestStore>>["client"];
let dropStore = async () => {};
before(async () => {
  const store = await createTestStore(env.fgaApiUrl, env.fgaApiToken);
  client = store.client;
  dropStore = async () => void (await store.client.deleteStore());
});
after(() => dropStore());

test("a sentence passes only as an approved claim, word for word, for its own country", () => {
  const dose = "Start CardioNex at 20mg once daily in adults with HFrEF.";
  assert.equal(checkSentence(dose, "US", CLAIMS).verdict, "APPROVED");
  assert.equal(checkSentence("start cardionex at 20mg once daily in adults with HFrEF", "US", CLAIMS).verdict, "APPROVED");
  // A paraphrase is a new claim until a reviewer signs it.
  assert.equal(checkSentence("Start CardioNex at 20 mg daily in HFrEF adults.", "US", CLAIMS).verdict, "UNAPPROVED_CLAIM");
  const german = checkSentence(dose, "DE", CLAIMS);
  assert.equal(german.verdict, "NOT_APPROVED_IN_COUNTRY");
  assert.equal(german.claim?.claimId, "C-02");
  assert.equal(german.suggestion?.claimId, "C-03");
});

test("a request names a saved draft, or the text after the colon and the country it goes to", () => {
  assert.deepEqual(readRequest("Fact-check the draft email draft-email-us."), { draftId: "draft-email-us" });
  assert.deepEqual(readRequest("Check this sentence for a German email: Start here."), { text: "Start here.", country: "DE" });
  assert.deepEqual(readRequest("Check this sentence: Start here."), { text: "Start here.", country: undefined });
  assert.equal(readHcpId("Suggest the next step for HCP-1001."), "HCP-1001");
});

// Every fact-check case, through the real graph. The stand-in suggests nothing, so a case passes
// on what the code decides alone.
for (const item of loadCases("fact-check")) {
  test(`${item.metadata.caseId} passes its text checks on the code's verdicts`, async () => {
    const model = standIn("suggest_claims", (prompt) => ({ suggestions: prompt.split("\n").filter((line) => /^\d+\. /.test(line)).map((_line, index) => ({ sentence: index + 1, claim_id: "none" })) }));
    const check = createFactChecker({ client: () => client, model: model.model });
    const { report } = await check({ request: readRequest(item.input.messages[0].content), user: scriptUser(item.input.tenantId, item.input.country, ["sales-rep"]) });
    assert.deepEqual(failedChecks(report, item.expectedOutput.checks), [], report);
    // Only a sentence no claim matches costs a model call.
    assert.equal(model.calls.length, /UNAPPROVED_CLAIM/.test(report) ? 1 : 0, report);
  });
}

test("another company's claims are not checked against, so pharma_b's check costs no model call", async () => {
  const model = standIn("suggest_claims", () => assert.fail("no model call expected"));
  const check = createFactChecker({ client: () => client, model: model.model });
  const { report, checks } = await check({ request: { text: "Start CardioNex at 20mg once daily in adults with HFrEF.", country: "US" }, user: scriptUser("pharma_b", "US", ["sales-rep"]) });
  assert.match(report, /^INSUFFICIENT_CONTEXT/);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].verdict, "UNAPPROVED_CLAIM");
});

test("a flagged email waits for a medical reviewer once, however often it is checked; an approved one does not", async () => {
  const items = new Map<string, string>();
  const inbox = { submit: async (item: { id: string; kind: string }) => (items.set(item.id, item.kind), { dueAt: new Date(), status: "waiting" as const }) };
  const model = standIn("suggest_claims", () => ({ suggestions: [{ sentence: 1, claim_id: "none" }] }));
  const check = createFactChecker({ client: () => client, model: model.model });
  const user = scriptUser("pharma_a", "US", ["sales-rep"]);
  const first = await check({ request: { draftId: "draft-email-us" }, user, inbox, threadId: "t-us" });
  const again = await check({ request: { draftId: "draft-email-us" }, user, inbox, threadId: "t-us-again" });
  assert.match(first.itemId ?? "", /^email-/);
  assert.equal(again.itemId, first.itemId);
  assert.equal(first.itemStatus, "waiting");
  assert.equal((await check({ request: { text: CLAIMS[0].text, country: "US" }, user, inbox, threadId: "t-ok" })).itemId, null);
  assert.deepEqual([...items.values()], ["email"]);
});

// What a model would propose for each outreach case. The rules decide the outcome from here.
const PROPOSALS: Record<string, Proposal> = {
  // The reference run's model called this a next step, not a campaign send. It is held all the same.
  "OUTREACH-01": { action: "next_step", asksForEmail: true, campaign: "heart-failure-update-nov", claimIds: [], rationale: "Asked again." },
  "OUTREACH-02": { action: "next_step", asksForEmail: true, campaign: null, claimIds: ["C-02"], rationale: "Next email." },
  "OUTREACH-03": { action: "next_step", asksForEmail: false, campaign: null, claimIds: ["C-01"], rationale: "Subgroup data, short email." },
  "OUTREACH-04": { action: "next_step", asksForEmail: false, campaign: null, claimIds: [], rationale: "unused" },
  "OUTREACH-05": { action: "next_step", asksForEmail: false, campaign: null, claimIds: ["C-03"], rationale: "German product text." },
  "OUTREACH-06": { action: "samples", asksForEmail: false, campaign: null, claimIds: [], rationale: "Pending request." }
};
const toArgs = (proposal: Proposal) => ({ action: proposal.action, asks_for_email: proposal.asksForEmail, campaign: proposal.campaign ?? "none", claim_ids: proposal.claimIds, rationale: proposal.rationale });

for (const item of loadCases("outreach")) {
  test(`${item.metadata.caseId} passes its text checks on the planner's rules`, async () => {
    const proposal = PROPOSALS[item.metadata.caseId];
    const model = standIn("propose_step", () => toArgs(proposal));
    const plan = createOutreachPlanner({ client: () => client, model: model.model });
    const { report } = await plan({ query: item.input.messages[0].content, user: scriptUser(item.input.tenantId, item.input.country, ["sales-rep"]) });
    assert.deepEqual(failedChecks(report, item.expectedOutput.checks), [], report);
    // A doctor the company cannot see is never shown to the model.
    assert.equal(model.calls.length, report.startsWith("INSUFFICIENT_CONTEXT") ? 0 : 1, report);
  });
}

test("a model cannot propose an email to a doctor who opted out, or a campaign sent twice", () => {
  const optedOut = recordOf(PROFILES.find((profile) => profile.hcpId === "HCP-1003")!);
  const us = CLAIMS.filter((claim) => claim.country === "US");
  const email: Proposal = { action: "email_campaign", asksForEmail: true, campaign: "renal-dosing-guide", claimIds: ["C-01"], rationale: "" };
  assert.equal(planOutreach(optedOut, email, us).outcome, "HOLD_OUTREACH");
  assert.equal(planOutreach(optedOut, email, us).email, null);
  const twice = recordOf(PROFILES.find((profile) => profile.hcpId === "HCP-1001")!);
  assert.equal(planOutreach(twice, { ...email, campaign: "heart-failure-update-nov" }, us).outcome, "HOLD_OUTREACH");
});

test("every email the planner writes passes the fact-checker, because it is only approved claims", () => {
  for (const profile of PROFILES) {
    const claims = CLAIMS.filter((claim) => claim.country === profile.country && claim.claimId.startsWith("C-"));
    const proposal: Proposal = { action: "next_step", asksForEmail: true, campaign: null, claimIds: claims.map((claim) => claim.claimId), rationale: "" };
    const { email } = planOutreach(recordOf(profile), proposal, claims);
    for (const sentence of email ?? []) assert.equal(checkSentence(sentence, profile.country, CLAIMS).verdict, "APPROVED", `${profile.hcpId}: ${sentence}`);
  }
});

test("a company plans outreach only for its own doctors", async () => {
  const model = standIn("propose_step", () => assert.fail("no model call expected"));
  const plan = createOutreachPlanner({ client: () => client, model: model.model });
  for (const [hcpId, tenant] of [["HCP-1004", "pharma_a"], ["HCP-1001", "pharma_b"], ["HCP-9999", "pharma_a"]]) {
    const result = await plan({ query: `What is the next step for ${hcpId}?`, user: scriptUser(tenant, "US", ["sales-rep"]) });
    assert.equal(result.outcome, "INSUFFICIENT_CONTEXT");
    // The same answer for a doctor of another company and one who does not exist: nothing leaks.
    assert.doesNotMatch(result.report, /neurology|cardiology|webinar/);
  }
});

test("a doctor signed in to the desk can use neither tool, so neither costs a model call", async () => {
  const model = standIn("propose_step", () => assert.fail("no model call expected"));
  const doctor = scriptUser("pharma_a", "US");
  const plan = createOutreachPlanner({ client: () => client, model: model.model });
  assert.equal((await plan({ query: "Next step for HCP-1001?", user: doctor })).outcome, "INSUFFICIENT_CONTEXT");
  const check = createFactChecker({ client: () => client, model: model.model });
  assert.match((await check({ request: { text: CLAIMS[0].text, country: "US" }, user: doctor })).report, /^INSUFFICIENT_CONTEXT/);
});
