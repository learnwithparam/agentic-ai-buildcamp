// PROMISE: the model picks tools in a loop, and a loop that never ends is stopped.
// A three-hop question needs two or more tool calls. A tool that never ends stops at MAX_TURNS.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/agent-loop";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("agent-loop", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
