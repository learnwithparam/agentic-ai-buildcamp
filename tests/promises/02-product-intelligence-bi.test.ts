// PROMISE: the analyst answers funnel questions from checked skills and never lists people.
// A query that runs unchecked, a lost skill or a leaked email fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/product-intelligence-bi";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("product-intelligence-bi", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
