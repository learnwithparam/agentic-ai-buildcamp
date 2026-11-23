// PROMISE: one agent answers the same question on the web, in MCP and in the terminal.
// The web reply streams as many events, and the chart reaches every surface that can draw it.
import { describe, test } from "bun:test";
import { checks } from "../../checks/surfaces";

describe("surfaces", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
