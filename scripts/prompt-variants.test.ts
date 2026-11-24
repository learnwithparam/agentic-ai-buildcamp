import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// medinfo-agent.ts builds its OpenAI client on import. CI has no key, and this test calls no model.
process.env.OPENAI_API_KEY ||= "not-used-by-this-test";
const { SYSTEM_PROMPT } = await import("../src/server/medinfo-agent");
const { ASK_FIRST_RULE, PROMPT_VARIANTS } = await import("./prompt-variants");

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
