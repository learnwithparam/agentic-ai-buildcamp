import "./load-env";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, isLangfuseConfigured } from "./env";
import { routes } from "./routes";

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_request, response) => {
  response.json({ ok: true, tracingConfigured: isLangfuseConfigured() });
});
app.use(routes);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../dist");

app.use(express.static(clientDist));
app.use((_request, response) => {
  response.sendFile(path.join(clientDist, "index.html"));
});

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`HCP Medical Information Agent server listening on http://127.0.0.1:${env.port}`);
});

async function shutdown() {
  server.close();
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
