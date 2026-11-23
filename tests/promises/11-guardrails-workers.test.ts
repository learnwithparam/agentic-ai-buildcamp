// PROMISE: orders hidden in text are not followed, and a job never runs twice.
// A followed order, a double run, a lost job or a run over its cap fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/guardrails-workers";
import { closeDatabase } from "../../packages/core/src/db";
import { stopJobs } from "../../packages/core/src/jobs";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(async () => {
  await stopJobs();
  await closeDatabase();
});

describe("guardrails-workers", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
