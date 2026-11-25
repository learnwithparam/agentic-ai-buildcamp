import { MemorySaver } from "@langchain/langgraph";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import pg from "pg";
import { createHandoffAgent } from "./a2a/handoff";
import { TaskReviews } from "./a2a/tasks";
import { createMedinfoAgent } from "./medinfo-agent";
import { createFactChecker } from "./content/fact-check";
import { createOutreachPlanner } from "./content/outreach";
import { InlineQueue, MemoryEventStore } from "./events/store";
import { ReviewStore } from "./reviews";
import type { Desk } from "./routes";

// Test-only: a desk with checkpoints in memory and no scores. Threads and the inbox live in the
// pool's database, so a test that opens a thread passes the test database's pool. A test that
// stops at sign-in or at MCP passes none: the default pool connects only on its first query.
export function testDesk(pool: pg.Pool = new pg.Pool({ max: 1 })): Desk {
  const store = new InMemoryTaskStore();
  return {
    agent: createMedinfoAgent(new MemorySaver()),
    factChecker: createFactChecker(),
    outreachPlanner: createOutreachPlanner(),
    reviews: new ReviewStore(pool),
    recordDecision: async () => {},
    a2a: { store, links: new TaskReviews(pool, store), handoff: createHandoffAgent() },
    events: { store: new MemoryEventStore(), queue: new InlineQueue(), secrets: {} }
  };
}
