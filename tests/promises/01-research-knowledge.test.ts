// PROMISE: the research teammate reports what moved on a rival page.
// A banner in the report, a lost closed tab or a repeated page fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/research-knowledge";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("research-knowledge", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
