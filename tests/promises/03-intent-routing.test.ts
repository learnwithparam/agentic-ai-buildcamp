// PROMISE: each question picks its path before the agent loop runs.
// Trivia gets a fixed reply with no model call, and a safety report goes to a person.
import { describe, test } from "bun:test";
import { checks } from "../../checks/intent-routing";

describe("intent-routing", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    }, 60000);
  }
});
