// PROMISE: the web chat, the MCP tool and the command line give the same answer from one agent.
// A door that changes the text, skips a check or lists no tool fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/surfaces";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(closeDatabase);

describe("surfaces", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
