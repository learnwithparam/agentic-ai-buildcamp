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
const desk = {
  agent: createMedinfoAgent(checkpointer),
  // Lesson 14: the fact-checker and the outreach planner share the inbox, the door and the sign-in.
  factChecker: createFactChecker(),
  outreachPlanner: createOutreachPlanner(),
  reviews: new ReviewStore(pool),
  recordDecision
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
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
