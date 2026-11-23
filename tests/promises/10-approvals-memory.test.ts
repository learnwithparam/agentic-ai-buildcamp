// PROMISE: a person must say yes before a reply is sent, and a restart loses nothing.
// A skipped interrupt, a double send or a leaked note fails here.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { checks } from "../../checks/approvals-memory";
import { stopApprovals } from "../../packages/core/src/approvals";
import { closeDatabase } from "../../packages/core/src/db";
import { loadSeed } from "../../packages/core/src/seed-load";
import { seed } from "../../scripts/seed";

beforeAll(async () => {
  await seed();
  await loadSeed();
});
afterAll(async () => {
  await stopApprovals();
  await closeDatabase();
});

describe("approvals-memory", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
