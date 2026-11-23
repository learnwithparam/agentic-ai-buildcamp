// PROMISE: the agent runs as a graph, keeps its place in Postgres and stops a cycle.
// A graph with no saved steps, or with no recursion limit, fails here.
import { afterAll, describe, test } from "bun:test";
import { checks } from "../../checks/langgraph-agent";
import { closeDatabase } from "../../packages/core/src/db";

afterAll(closeDatabase);

describe("langgraph-agent", () => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(1);
    });
  }
});
