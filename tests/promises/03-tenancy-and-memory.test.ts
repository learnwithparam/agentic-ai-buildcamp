// PROMISE: each workspace keeps its memo, its tone notes and its approvals to itself.
// A leaked memo, a shared note or a self approval fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/tenancy-and-memory";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("tenancy-and-memory", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
