// PROMISE: the agent reads only the label in force today, and a repeat upload changes nothing.
// The old label, the expired draft and the future label stay hidden. A scan is read with OCR.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/documents-freshness";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("documents-freshness", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
