import assert from "node:assert/strict";
import { test } from "node:test";
import { raiseToSafety, TIERS, type Route, type Tier } from "../tiers";
import type { Detection } from "./detect";
import { DETECT_PROMPT, SPECIAL_SITUATIONS } from "./detect";

// The two layers of the safety check, as code: the router's tier and the second pass's yes or no.
// What the model says in each is proven on the real model (safety.live.ts, npm run ae:measure).
// Here no model is called.

const route = (tier: Tier): Route => ({ tier, reason: "router reason", asksForAdvice: false });
const seen = (happened: boolean): Detection => ({ happened, harm: happened, specialSituation: null, reason: "a patient fainted after the tablet" });

test("either layer saying yes routes the message to safety", () => {
  assert.equal(raiseToSafety(route("safety"), seen(false)).tier, "safety", "router yes, second pass no");
  assert.equal(raiseToSafety(route("answer"), seen(true)).tier, "safety", "router no, second pass yes");
  assert.equal(raiseToSafety(route("safety"), seen(true)).tier, "safety", "both yes");
});

test("both layers saying no leaves the answer an answer", () => {
  const same = raiseToSafety(route("answer"), seen(false));
  assert.deepEqual(same, route("answer"));
});

test("the second pass only raises an answer: review and stop keep their tier", () => {
  for (const tier of TIERS.filter((t) => t !== "answer" && t !== "safety")) assert.equal(raiseToSafety(route(tier), seen(true)).tier, tier);
});

test("a raised message says which layer raised it", () => {
  const raised = raiseToSafety(route("answer"), seen(true));
  assert.match(raised.reason, /router reason/);
  assert.match(raised.reason, /second pass/);
});

test("the second pass asks one question and names the special situations", () => {
  assert.match(DETECT_PROMPT, /happened to a patient after a medicine/);
  for (const text of ["pregnan", "overdose", "medication error", "lack of effect"]) assert.ok(DETECT_PROMPT.includes(text), text);
  assert.deepEqual([...SPECIAL_SITUATIONS], ["pregnancy_exposure", "overdose", "medication_error", "lack_of_efficacy", "off_label_use"]);
});

// Measured on 2026-11-26: "what share stopped because of dizziness?" was raised as an adverse
// event, twice in 66 messages. A rate across patients or a trial is a question, not a report.
test("the second pass treats a question about rates across patients or a trial as no report", () => {
  assert.match(DETECT_PROMPT, /across patients or in a trial/);
});

// Issue #122. EU GVP Module VI: a pregnancy exposure with the patient well is reported, and the
// doctor's question is still answered. A harm, or any other yes, gets the safety reply alone.
test("a special situation with no harm stays an answer and opens a report, from either layer", () => {
  const exposure: Detection = { happened: true, harm: false, specialSituation: "pregnancy_exposure", reason: "9 weeks pregnant on CardioNex" };
  for (const tier of ["answer", "safety"] as const) {
    const raised = raiseToSafety(route(tier), exposure);
    assert.equal(raised.tier, "answer", tier);
    assert.equal(raised.report, "pregnancy_exposure", tier);
  }
  assert.equal(raiseToSafety(route("answer"), { ...exposure, harm: true }).tier, "safety", "an exposure with harm");
  assert.equal(raiseToSafety(route("answer"), { ...exposure, harm: true }).report, undefined);
  assert.equal(raiseToSafety(route("stop"), exposure).tier, "stop", "stop keeps its tier");
  assert.equal(raiseToSafety(route("answer"), seen(true)).report, undefined, "a harm with no special situation");
});

test("the second pass asks whether harm followed", () => {
  assert.match(DETECT_PROMPT, /Set harm to true/);
});
