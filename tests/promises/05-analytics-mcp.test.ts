// PROMISE: the agent gets numbers through a guarded tool, and no private value ever leaves it.
// A query for emails, another workspace or a write is refused before it runs.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/analytics-mcp";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("analytics-mcp", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
