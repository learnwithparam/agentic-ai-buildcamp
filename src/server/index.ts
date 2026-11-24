import "./load-env";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env";
import { routes } from "./routes";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_request, response) => {
  response.json({ ok: true, tracingConfigured: false });
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
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
