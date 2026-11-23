// The Hono server. One agent sits behind four doors: a chat stream, a resume call,
// a list of waiting approvals and an MCP tool. Sign-in is a stub until the access-control module.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as web from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Approval } from "./approvals";
import { chatEvents, DEFAULT_PERSON, type Reply, type SurfaceAgent, TOOL_NAME } from "./surfaces";

export type Decision = "approve" | "reject";
export type Deps = {
  agent: SurfaceAgent;
  pending: (approver: string) => Promise<Approval[]>;
  resume: (threadId: string, decision: Decision, person: string) => Promise<Reply>;
};

type ChatBody = { messages?: { role?: string; content?: unknown }[]; person?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function questionOf(body: ChatBody): string {
  const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  return textOf(last?.content);
}

// Until sign-in is on, the caller names the person. That is for local use only.
function personOf(context: Context, body: ChatBody): string {
  const named = context.req.header("x-person") ?? textOf(body.person);
  return named === "" ? DEFAULT_PERSON : named;
}

async function bodyOf(context: Context): Promise<ChatBody> {
  return context.req.json<ChatBody>().catch(() => ({}));
}

function streamReply(context: Context, reply: Reply): Response {
  return streamSSE(context, async (stream) => {
    for await (const event of chatEvents(reply)) await stream.writeSSE(event);
  });
}

// #region step:surfaces
function mcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "hcp-showcase", version: "1.0.0" });
  const question = z.string().min(1);
  const person = z.string().optional();
  const inputSchema = { question, person };
  const description = "Ask the medical affairs team. The reply may carry a chart.";
  server.registerTool(TOOL_NAME, { description, inputSchema }, async (input) => {
    const reply = await deps.agent(input.question, input.person ?? DEFAULT_PERSON);
    const content = [{ type: "text" as const, text: reply.text }];
    if (reply.chart !== undefined) {
      content.push({ type: "text" as const, text: JSON.stringify(reply.chart) });
    }
    return { content };
  });
  return server;
}

// Each request gets a fresh server, so no session is kept.
async function handleMcp(context: Context, deps: Deps): Promise<Response> {
  const server = mcpServer(deps);
  const transport = new web.WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(context.req.raw);
}

function addChatRoutes(app: Hono, deps: Deps): void {
  app.post("/v1/chat/completions", async (context) => {
    const body = await bodyOf(context);
    const question = questionOf(body);
    if (question === "") return context.json({ error: "Send a question." }, 400);
    return streamReply(context, await deps.agent(question, personOf(context, body)));
  });
  app.post("/v1/threads/:id/resume", async (context) => {
    const body = (await bodyOf(context)) as ChatBody & { decision?: string };
    if (body.decision !== "approve" && body.decision !== "reject") {
      return context.json({ error: "Say approve or reject." }, 400);
    }
    const reply = await deps.resume(
      context.req.param("id"),
      body.decision,
      personOf(context, body),
    );
    return streamReply(context, reply);
  });
}

export function buildApp(deps: Deps): Hono {
  const app = new Hono();
  app.use("*", cors());
  addChatRoutes(app, deps);
  app.get("/v1/approvals/pending", async (context) => {
    const approver = context.req.query("approver") ?? DEFAULT_PERSON;
    return context.json(await deps.pending(approver));
  });
  app.post("/v1/sign-in", (context) =>
    context.json({ error: "Sign-in arrives in the access-control module." }, 501),
  );
  app.post("/mcp", (context) => handleMcp(context, deps));
  app.on(["GET", "DELETE"], "/mcp", (context) => context.text("Use POST.", 405));
  return app;
}
// #stub
//~ // TODO(surfaces): serve the chat stream, resume, pending approvals and /mcp from one Hono app
//~ export function buildApp(_deps: Deps): Hono {
//~   return new Hono();
//~ }
// #endregion

export function startServer(deps: Deps, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch: buildApp(deps).fetch });
}
