// PROMISE: the teammates run on events and the Monday clock, and a crash never doubles a briefing.
// Ten runs for ten events, or two drafts after a crash, fail here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/always-on-teammates";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("always-on-teammates", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
