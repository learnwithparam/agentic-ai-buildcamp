// PROMISE: each person sees only what their company, role, clearance and territory allow.
// A missing wall, a skipped check or a forged token fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/access-control";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("access-control", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
