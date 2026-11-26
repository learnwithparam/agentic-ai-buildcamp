import assert from "node:assert/strict";
import { test } from "node:test";
import { RegressionError } from "@langfuse/client";
import { scriptedAgent, scriptedReleaseRows } from "./eval-agents";
import { hasCitationRule, hasDeferRule, sabotage, sabotageCaught, SABOTAGE_EXIT } from "./eval-sabotage";
import { needsCitation, needsDefer } from "./eval-scripted";
import { loadAllCases } from "./hcp-cases";
import { PROMPT_VARIANTS } from "./prompt-variants";
import { assertReleasable, RELEASE_CASES, releasePassRate } from "./release-gate";

const byId = new Map(loadAllCases().map((item) => [item.metadata.caseId, item]));

// The release run's rows, scored by the scripted agent on a prompt.
async function gateOn(prompt: string) {
  const itemResults = scriptedReleaseRows(prompt);
  return { itemResults, runEvaluations: [await releasePassRate({ itemResults: itemResults as never })].flat() };
}

test("the sabotage removes the citation rule and every defer rule, and nothing else", () => {
  const good = PROMPT_VARIANTS["per-company"];
  const broken = sabotage(good);
  assert.ok(hasCitationRule(good) && hasDeferRule(good));
  assert.ok(!hasCitationRule(broken.prompt) && !hasDeferRule(broken.prompt));
  assert.equal(broken.droppedCitation.length, 1);
  assert.equal(broken.droppedDefer.length, 4);
  assert.equal(good.split("\n").length - broken.prompt.split("\n").length, 5);
  for (const line of broken.prompt.split("\n")) assert.ok(good.includes(line));
});

test("it works on every prompt variant that has both rules, and refuses one that has neither", () => {
  for (const [name, prompt] of Object.entries(PROMPT_VARIANTS)) {
    if (hasCitationRule(prompt) && hasDeferRule(prompt)) assert.ok(!hasDeferRule(sabotage(prompt).prompt), name);
  }
  assert.ok(Object.values(PROMPT_VARIANTS).filter((prompt) => hasDeferRule(prompt)).length >= 5);
  assert.throws(() => sabotage("Answer the question."), /no citation line/);
  assert.throws(() => sabotage("Answer from the label text you found, and cite each fact as [doc_id, section]."), /no defer rule/);
});

test("the release cases include a case that needs the citation rule and one that needs a defer rule", () => {
  const release = RELEASE_CASES.map((id) => byId.get(id)!);
  assert.ok(release.some(needsCitation), "no release case would notice a missing citation rule");
  assert.ok(release.some(needsDefer), "no release case would notice a missing defer rule");
});

test("the gate is green on the real prompt and red on the sabotaged one", async () => {
  const good = PROMPT_VARIANTS["per-company"];
  const green = await gateOn(good);
  assert.doesNotThrow(() => assertReleasable(green as never));
  const red = await gateOn(sabotage(good).prompt);
  assert.throws(() => assertReleasable(red as never), RegressionError);
  assert.equal(sabotageCaught(() => assertReleasable(red as never)), true);
  assert.equal(sabotageCaught(() => assertReleasable(green as never)), false);
});

test("a gate that stays green on the sabotaged prompt is reported as not catching it, and any other error is not swallowed", async () => {
  const green = await gateOn(PROMPT_VARIANTS["per-company"]);
  assert.equal(sabotageCaught(() => assertReleasable(green as never)), false);
  assert.throws(() => sabotageCaught(() => { throw new Error("network"); }), /network/);
  for (const code of Object.values(SABOTAGE_EXIT)) assert.ok(Number(code) > 0, "both outcomes exit non-zero");
  assert.notEqual(SABOTAGE_EXIT.caught, SABOTAGE_EXIT.missed);
});

test("the scripted agent reports the sabotage caught, through the same verdict code as the gate", async () => {
  assert.equal(await scriptedAgent().sabotageCaught(), true);
});
