import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Auth } from "./auth";
import { isLangfuseConfigured } from "./env";
import { createMcpRouter } from "./mcp";
import { createRoutes } from "./routes";

// The whole HTTP surface in one place, so src/server/auth.test.ts can walk the same app the server runs.
export function createApp(auth: Auth) {
  const app = express();
  // Behind a TLS proxy in production, so request.protocol reads the original https.
  app.set("trust proxy", "loopback");
  // Lesson 12: MCP takes tokens, never cookies, so it sits before the cookie checks below.
  app.use(createMcpRouter(auth));
  app.use("/api", auth.sameOrigin);
  app.use(express.json({ limit: "1mb" }));
  app.use(auth.router);
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, tracingConfigured: isLangfuseConfigured() });
  });
  app.use(createRoutes(auth));

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(currentDir, "../../dist");
  app.use(express.static(clientDist));
  app.use((_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });
  return app;
}
