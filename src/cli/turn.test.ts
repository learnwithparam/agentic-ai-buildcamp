import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_DEFINITIONS } from "../server/tools";
import { TOOL_WORDS } from "./turn";

// Every tool the agent's model may call says what it is doing in the terminal, so a tool added
// to src/server/tools.ts without its phrase fails here instead of showing "Looking it up".
test("every agent tool has a phrase in the CLI", () => {
  const names = TOOL_DEFINITIONS.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []));
  assert.ok(names.length >= 6);
  assert.deepEqual(names.filter((name) => !TOOL_WORDS[name]), []);
});
