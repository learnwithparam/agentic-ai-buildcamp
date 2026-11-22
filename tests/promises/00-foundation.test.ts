// PROMISE: the stack runs, the seeded data is loaded, and the naive agent shows its flaws.
// The naive prompt holds the old OncoX label beside the new one, and every prescriber email.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { naivePrompt } from "../../apps/hcp-showcase/src/naive";
import { checks } from "../../checks/foundation";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

// A fresh load each time, so a broken loader cannot hide behind old rows.
beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("foundation", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
  test("the old dose and the new dose both reach the prompt", () => {
    const prompt = naivePrompt("What is the OncoX dose in the United States?");
    expect(prompt.includes("100 mg once daily")).toBe(true);
    expect(prompt.includes("150 mg once daily")).toBe(true);
  });
});
