import "./load-env";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { createPool, migrate } from "./db";
import { env } from "./env";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createFactChecker } from "./content/fact-check";
import { createOutreachPlanner } from "./content/outreach";
import { createMedinfoAgent, recordDecision } from "./medinfo-agent";
import { createHandoffAgent } from "./a2a/handoff";
import { createTaskStore, TaskReviews } from "./a2a/tasks";
import { createEventHandler } from "./events/handlers";
import { PostgresEventStore, startEventQueue } from "./events/store";
import { eventSecrets } from "./events/webhook";
import { ReviewStore } from "./reviews";
import { PostgresSessionStore } from "./sessions";

// Lesson 11. Sessions live in the app's own Postgres; Keycloak signs the doctors in.
// npm run identity:setup starts both and writes their settings to .env.
const pool = createPool(env.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

// Lesson 13. Every step of every thread is saved in the same Postgres, in its own schema, so a
// draft waiting for a reviewer is still waiting after a restart. setup() creates the tables once.
const checkpointer = new PostgresSaver(pool, undefined, { schema: "langgraph" });
await checkpointer.setup();
// Lesson 15. A2A tasks live in the same Postgres (migration 005), so a task waiting for a
// reviewer outlives a restart, as a waiting draft does.
const a2aStore = createTaskStore(pool);
const agent = createMedinfoAgent(checkpointer);
// Lesson 14: the fact-checker and the outreach planner share the inbox, the door and the sign-in.
const factChecker = createFactChecker();
const outreachPlanner = createOutreachPlanner();
const reviews = new ReviewStore(pool);
// Lesson 16. Events are stored in the same Postgres (migration 006), and their jobs wait in
// pg-boss there too. The worker runs in this process and starts the same agents a chat does.
const eventStore = new PostgresEventStore(pool);
const eventQueue = await startEventQueue(env.databaseUrl, eventStore, createEventHandler({ agent, factChecker, outreachPlanner, inbox: reviews }));
const desk = {
  agent,
  factChecker,
  outreachPlanner,
  reviews,
  recordDecision,
  a2a: { store: a2aStore, links: new TaskReviews(pool, a2aStore), handoff: createHandoffAgent() },
  events: { store: eventStore, queue: eventQueue.queue, secrets: eventSecrets() }
};

const auth = createAuth({
  issuer: env.oidcIssuer,
  audience: env.oidcAudience,
  clientId: env.oidcClientId,
  clientSecret: env.oidcClientSecret,
  appUrl: env.appUrl,
  sessions: new PostgresSessionStore(pool)
});

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

const server = createApp(auth, desk).listen(env.port, "127.0.0.1", () => {
  console.log(`HCP Medical Information Agent server listening on http://127.0.0.1:${env.port}`);
});

async function shutdown() {
  server.close();
  // The worker finishes the event it holds before the pool closes.
  await eventQueue.stop();
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
