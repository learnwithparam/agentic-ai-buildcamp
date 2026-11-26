import assert from "node:assert/strict";
import { test } from "node:test";
import { raiseToSafety, TIERS, type Route, type Tier } from "../tiers";
import type { Detection } from "./detect";
import { DETECT_PROMPT, SPECIAL_SITUATIONS } from "./detect";

// The two layers of the safety check, as code: the router's tier and the second pass's yes or no.
// What the model says in each is proven on the real model (safety.live.ts, npm run ae:measure).
// Here no model is called.

const route = (tier: Tier): Route => ({ tier, reason: "router reason", asksForAdvice: false });
const seen = (happened: boolean): Detection => ({ happened, specialSituation: null, reason: "a patient fainted after the tablet" });

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
