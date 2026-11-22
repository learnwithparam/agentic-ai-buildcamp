// PROMISE: a release goes out only when every golden case passes.
// A stale label or a failed case closes the gate.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/release-gate";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("release-gate", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    }, 60000);
  }
});
