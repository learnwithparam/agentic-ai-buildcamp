import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// medinfo-agent.ts builds its OpenAI client on import. CI has no key, and this test calls no model.
process.env.OPENAI_API_KEY ||= "not-used-by-this-test";
const { SYSTEM_PROMPT } = await import("../src/server/medinfo-agent");
const PROMPT_VARIANTS_MODULE = await import("./prompt-variants");
const { ASK_FIRST_RULE, PROMPT_VARIANTS } = PROMPT_VARIANTS_MODULE;

test("the ask-first variant is the system prompt plus one line", () => {
  const before = SYSTEM_PROMPT.split("\n");
  const after = PROMPT_VARIANTS["ask-first"].split("\n");
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((line) => line !== ASK_FIRST_RULE), before);
});

test("lesson 03 shows the same line the script publishes", () => {
  const page = readFileSync(new URL("../docs/learner/03-prompt-management.md", import.meta.url), "utf8");
  assert.ok(page.includes(ASK_FIRST_RULE), "docs/learner/03-prompt-management.md does not show ASK_FIRST_RULE");
});

// Lesson 04 ends with this prompt and lesson 07 tells learners to paste it, so both pages must
// show it word for word. Lesson 04 quotes it, so a leading "> " on each line is allowed there.
test("lessons 04 and 07 show the error-analysis prompt the script publishes", () => {
  const prompt = PROMPT_VARIANTS["error-analysis"].trim();
  for (const file of ["04-monitoring/error-analysis.md", "07-evaluation.md"]) {
    const page = readFileSync(new URL(`../docs/learner/${file}`, import.meta.url), "utf8");
    const unquoted = page.replace(/^> ?/gm, "");
    assert.ok(unquoted.includes(prompt), `docs/learner/${file} does not show the error-analysis prompt`);
  }
});

// Lesson 11 tells learners to publish the signed-in prompt and shows it, so the page must match.
test("lesson 11 shows the signed-in prompt the script publishes", () => {
  const page = readFileSync(new URL("../docs/learner/11-sign-in-and-permissions.md", import.meta.url), "utf8");
  assert.ok(page.includes(PROMPT_VARIANTS["signed-in"].trim()), "docs/learner/11-sign-in-and-permissions.md does not show the signed-in prompt");
});

// Lesson 13 takes out the two lines the graph now keeps, and the page shows the result.
test("the tiered prompt is the signed-in prompt without the rules the graph keeps", () => {
  const tiered = PROMPT_VARIANTS.tiered;
  assert.doesNotMatch(tiered, /PV_ESCALATION|REVIEW_REQUIRED/);
  assert.equal(tiered.split("\n").length, PROMPT_VARIANTS["signed-in"].split("\n").length - 1);
  const page = readFileSync(new URL("../docs/learner/13-durable-state-and-review.md", import.meta.url), "utf8");
  assert.ok(page.includes(tiered.trim()), "docs/learner/13-durable-state-and-review.md does not show the tiered prompt");
});

// Lesson 20 adds one rule and asks for one bracket per section; the page shows both.
test("the library prompt is the tiered prompt plus the stricter-limit rule", () => {
  const { STRICTER_LIMIT_RULE } = PROMPT_VARIANTS_MODULE;
  const tiered = PROMPT_VARIANTS.tiered.split("\n");
  const library = PROMPT_VARIANTS.library.split("\n");
  assert.equal(library.length, tiered.length + 1);
  assert.ok(library.includes(STRICTER_LIMIT_RULE));
  assert.match(PROMPT_VARIANTS.library, /cite each fact as \[doc_id, section\], one bracket per section\./);
  const page = readFileSync(new URL("../docs/learner/20-rag.md", import.meta.url), "utf8");
  assert.ok(page.includes(STRICTER_LIMIT_RULE), "docs/learner/20-rag.md does not show the stricter-limit rule");
  assert.ok(page.includes("WORKSHOP_PROMPT_VARIANT=library npm run prompt:publish -- --label staging"), "docs/learner/20-rag.md does not show how to publish it");
});
