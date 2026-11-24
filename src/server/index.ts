import "./load-env";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { createPool, migrate } from "./db";
import { env } from "./env";
import { PostgresSessionStore } from "./sessions";

// Lesson 11. Sessions live in the app's own Postgres; Keycloak signs the doctors in.
// npm run identity:setup starts both and writes their settings to .env.
const pool = createPool(env.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

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

const server = createApp(auth).listen(env.port, "127.0.0.1", () => {
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
