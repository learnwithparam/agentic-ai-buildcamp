// PROMISE: one model call leaves one nested trace in Phoenix with its tokens, cost and tags.
// Replay serves the reply, so no key is needed.
import { describe, test } from "bun:test";
import { checks } from "../../checks/gateway-tracing";

describe("gateway-tracing", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    }, 60000);
  }
});
