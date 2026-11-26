// Lesson 20. npm run rag:ingest: reads every label PDF into the pgvector index search_labels uses.
// Run it after npm run rag:setup, and again whenever data/hcp/pdf changes. A PDF that has not
// changed is skipped, so a second run makes no model calls.
import "../src/server/load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createPool, migrate } from "../src/server/db";
import { env } from "../src/server/env";
import { embed, EMBEDDING_MODEL, useService } from "../src/server/gateway";
import { ingestLibrary, type ManifestDoc } from "../src/server/rag/ingest";
import { LabelChunkStore } from "../src/server/rag/store";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!env.databaseUrl) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");

// The embedding calls are traced and run on the app's own gateway key: the index serves the app.
const spans = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [spans] });
sdk.start();
useService("medinfo-app");

const pool = createPool(env.databaseUrl);
try {
  await migrate(pool);
  const { docs } = JSON.parse(readFileSync(path.join(root, "data/hcp/pdf/manifest.json"), "utf8")) as { docs: ManifestDoc[] };
  const results = await ingestLibrary(docs, {
    root,
    store: new LabelChunkStore(pool),
    embed,
    model: EMBEDDING_MODEL,
    log: (line) => console.log(line)
  });
  const failed = results.filter((result) => result.outcome === "failed");
  if (failed.length) {
    console.error(`${failed.length} PDFs were not stored. Nothing else changed.`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  await spans.forceFlush();
  await sdk.shutdown();
}
