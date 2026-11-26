import { startSafetyClock } from "./safety/clock";
import "./load-env";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { createPool, migrate } from "./db";
import { connectLabelIndex } from "./rag/search";
import { env } from "./env";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createFactChecker } from "./content/fact-check";
import { createOutreachPlanner } from "./content/outreach";
import { createMedinfoAgent, recordDecision } from "./medinfo-agent";
import { modelSpanFinder } from "./phi.model";
import { createInsightsAgent } from "./bi/agent";
import { createHandoffAgent } from "./a2a/handoff";
import { createTaskStore, TaskReviews } from "./a2a/tasks";
import { createEventHandler } from "./events/handlers";
import { PostgresEventStore, startEventQueue } from "./events/store";
import { langfuseSpend, PostgresAgentControls } from "./auto/limits";
import { PostgresSweepRuns, startSweepQueue } from "./auto/queue";
import { createSweep } from "./auto/sweep";
import { eventSecrets } from "./events/webhook";
import { ReviewStore } from "./reviews";
import { PostgresSessionStore } from "./sessions";
import { TENANTS } from "./users";

// Lesson 11. Sessions live in the app's own Postgres; Keycloak signs the doctors in.
// npm run identity:setup starts both and writes their settings to .env.
const pool = createPool(env.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
// Lesson 20. search_labels reads the pgvector index of the label PDFs that npm run rag:ingest builds.
console.log(`Label index: ${await connectLabelIndex(pool)} passages`);

// Lesson 13. Every step of every thread is saved in the same Postgres, in its own schema, so a
// draft waiting for a reviewer is still waiting after a restart. setup() creates the tables once.
const checkpointer = new PostgresSaver(pool, undefined, { schema: "langgraph" });
await checkpointer.setup();
// Lesson 15. A2A tasks live in the same Postgres (migration 005), so a task waiting for a
// reviewer outlives a restart, as a waiting draft does.
const a2aStore = createTaskStore(pool);
// Lesson 13. Names and addresses the rules miss go to one model call, unless PHI_MODEL_FINDER=off.
const agent = createMedinfoAgent(checkpointer, { phiFinder: process.env.PHI_MODEL_FINDER === "off" ? undefined : modelSpanFinder() });
// Lesson 14: the fact-checker and the outreach planner share the inbox, the door and the sign-in.
const factChecker = createFactChecker();
const outreachPlanner = createOutreachPlanner();
const reviews = new ReviewStore(pool);
// Every minute: an adverse event past its 24 hours is escalated (src/server/safety/clock.ts).
startSafetyClock(pool);
// Lesson 16. Events are stored in the same Postgres (migration 006), and their jobs wait in
// pg-boss there too. The worker runs in this process and starts the same agents a chat does.
const eventStore = new PostgresEventStore(pool);
const eventDesk = { agent, factChecker, outreachPlanner, inbox: reviews };
const eventQueue = await startEventQueue(env.databaseUrl, eventStore, createEventHandler(eventDesk));

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

// Lesson 17. The nightly sweep: its limits and run log in the same Postgres (migration 007), its
// schedule on the same pg-boss, and its spend read from Langfuse after this process sends its spans.
const sweepControls = new PostgresAgentControls(pool);
const sweepRuns = new PostgresSweepRuns(pool);
const spend = langfuseSpend({ flush: () => langfuseSpanProcessor.forceFlush() });
const sweepQueue = await startSweepQueue(eventQueue.boss, createSweep({ desk: eventDesk, controls: sweepControls, spend }), sweepRuns, Object.keys(TENANTS));
const desk = {
  agent,
  factChecker,
  outreachPlanner,
  reviews,
  recordDecision,
  a2a: { store: a2aStore, links: new TaskReviews(pool, a2aStore), handoff: createHandoffAgent() },
  events: { store: eventStore, queue: eventQueue.queue, secrets: eventSecrets() },
  sweep: { controls: sweepControls, runs: sweepRuns, queue: sweepQueue, spend },
  insights: createInsightsAgent(checkpointer)
};

const auth = createAuth({
  issuer: env.oidcIssuer,
  audience: env.oidcAudience,
  clientId: env.oidcClientId,
  clientSecret: env.oidcClientSecret,
  appUrl: env.appUrl,
  sessions: new PostgresSessionStore(pool)
});

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
