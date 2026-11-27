import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Auth } from "./auth";
import { isLangfuseConfigured } from "./env";
import { FactCheckExecutor, OutreachExecutor } from "./a2a/executors";
import { createA2aRouter } from "./a2a/server";
import { createEventRouter } from "./events/webhook";
import { createMcpRouter } from "./mcp";
import { chatLimit, type ChatLimiter } from "./ops/limits";
import { createRoutes, type Desk } from "./routes";

// The whole HTTP surface in one place, so src/server/auth.test.ts can walk the same app the server runs.
export function createApp(auth: Auth, desk: Desk, limiter?: Pick<ChatLimiter, "take">) {
  const app = express();
  // Behind a TLS proxy in production, so request.protocol reads the original https.
  app.set("trust proxy", "loopback");
  // Lesson 12: MCP takes tokens, never cookies, so it sits before the cookie checks below.
  app.use(createMcpRouter(auth));
  // Lesson 15: the A2A agents take tokens too, for the same reason.
  const tasks = { inbox: desk.reviews, links: desk.a2a.links };
  app.use(
    createA2aRouter(auth, {
      store: desk.a2a.store,
      executors: { "fact-checker": new FactCheckExecutor(desk.factChecker, tasks), "outreach-planner": new OutreachExecutor(desk.outreachPlanner, tasks) }
    })
  );
  // Lesson 16: events are signed by their sender, not signed in. The signature covers the raw
  // body, so this sits before the JSON parser below.
  app.use(createEventRouter({ secrets: desk.events.secrets, store: desk.events.store, queue: desk.events.queue }));
  app.use("/api", auth.sameOrigin);
  app.use(express.json({ limit: "1mb" }));
  app.use(auth.router);
  // Per-user limits on the two chat streams (src/server/ops/limits.ts). Each is a model call, so each
  // counts; a review decision and the other routes do not. The sign-in check runs first: a limit
  // needs to know who asked.
  if (limiter) {
    app.post(["/api/threads/:threadId/runs/stream", "/api/insights/threads/:threadId/runs/stream"], auth.requireUser, chatLimit(limiter));
  }
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, tracingConfigured: isLangfuseConfigured() });
  });
  app.use(createRoutes(auth, desk));

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(currentDir, "../../dist");
  app.use(express.static(clientDist));
  app.use((_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });
  return app;
}
