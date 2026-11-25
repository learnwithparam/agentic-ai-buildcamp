import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestStore } from "../../../scripts/fga-model";
import { noModelCall } from "../../../scripts/no-model-call";
import { env } from "../env";
import { scriptUser } from "../users";
import { checkSentence, createFactChecker, readRequest } from "./fact-check";
import { createOutreachPlanner, planOutreach, readHcpId, type Proposal } from "./outreach";
import { CLAIMS, PROFILES, recordOf } from "./records";

// Lesson 14. What the fact-checker and the outreach planner promise in code alone, against a real
// OpenFGA store made for the test: the verdicts, the holds and the tenancy. No model is used here.
// What they do with the real model, case by case, is content.live.ts (npm run check:live).

if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

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

test("another company's claims are not checked against, so pharma_b's check costs no model call", async () => {
  const check = createFactChecker({ client: () => client, model: noModelCall });
  const { report, checks } = await check({ request: { text: "Start CardioNex at 20mg once daily in adults with HFrEF.", country: "US" }, user: scriptUser("pharma_b", "US", ["sales-rep"]) });
  assert.match(report, /^INSUFFICIENT_CONTEXT/);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].verdict, "UNAPPROVED_CLAIM");
});

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
  const plan = createOutreachPlanner({ client: () => client, model: noModelCall });
  for (const [hcpId, tenant] of [["HCP-1004", "pharma_a"], ["HCP-1001", "pharma_b"], ["HCP-9999", "pharma_a"]]) {
    const result = await plan({ query: `What is the next step for ${hcpId}?`, user: scriptUser(tenant, "US", ["sales-rep"]) });
    assert.equal(result.outcome, "INSUFFICIENT_CONTEXT");
    // The same answer for a doctor of another company and one who does not exist: nothing leaks.
    assert.doesNotMatch(result.report, /neurology|cardiology|webinar/);
  }
});

test("a doctor signed in to the desk can use neither tool, so neither costs a model call", async () => {
  const doctor = scriptUser("pharma_a", "US");
  const plan = createOutreachPlanner({ client: () => client, model: noModelCall });
  assert.equal((await plan({ query: "Next step for HCP-1001?", user: doctor })).outcome, "INSUFFICIENT_CONTEXT");
  const check = createFactChecker({ client: () => client, model: noModelCall });
  assert.match((await check({ request: { text: CLAIMS[0].text, country: "US" }, user: doctor })).report, /^INSUFFICIENT_CONTEXT/);
});
