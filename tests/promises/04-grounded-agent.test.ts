// PROMISE: the agent answers only from active documents, and a made-up claim is refused.
// A model reply that cites nothing, or uses a number outside its source, never reaches a reader.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/grounded-agent";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("grounded-agent", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
