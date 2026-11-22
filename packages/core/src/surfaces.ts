// Three doors lead to one agent: a web chat, an MCP tool and a command line.
// Each door only turns its own format into a question and back. The answer is always the same.
import type { Agent } from "./team";

export const TOOL_NAME = "ask_team";
const DEFAULT_TENANT = "pharma-a";
const PROTOCOL_VERSION = "2025-03-26";
const METHOD_NOT_FOUND = -32601;

type ChatBody = { question?: unknown; tenant?: unknown };
type ToolCall = { name?: string; arguments?: ChatBody };
export type McpMessage = { id?: number | string; method?: string; params?: ToolCall };
export type McpReply = { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: unknown };

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

function tenantOf(value: unknown): string {
  const tenant = textOf(value);
  if (tenant === "") return DEFAULT_TENANT;
  return tenant;
}

const BOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Medical affairs team</title></head>
<body>
<h1>Ask the medical affairs team</h1>
<form id="ask"><input id="question" size="60" placeholder="Ask about a label or a territory">
<button>Ask</button></form>
<pre id="answer"></pre>
<script>
document.getElementById("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = document.getElementById("question").value;
  const reply = await fetch("/chat", { method: "POST", body: JSON.stringify({ question }) });
  const text = await reply.text();
  document.getElementById("answer").textContent = JSON.parse(text.split("data: ")[1]).text;
});
</script></body></html>`;

// #region step:surfaces
export async function chatResponse(request: Request, agent: Agent): Promise<Response> {
  const body = (await request.json()) as ChatBody;
  const question = textOf(body.question);
  if (question === "") return new Response("Send a question.", { status: 400 });
  const result = await agent(question, tenantOf(body.tenant));
  const event = `event: answer\ndata: ${JSON.stringify(result)}\n\n`;
  return new Response(event, { headers: { "content-type": "text/event-stream" } });
}

function toolList(): unknown[] {
  const properties = { question: { type: "string" }, tenant: { type: "string" } };
  const inputSchema = { type: "object", properties, required: ["question"] };
  return [{ name: TOOL_NAME, description: "Ask the medical affairs team.", inputSchema }];
}

async function callTool(call: ToolCall | undefined, agent: Agent): Promise<unknown> {
  if (call === undefined || call.arguments === undefined) {
    return { isError: true, content: [{ type: "text", text: "Send a question." }] };
  }
  const question = textOf(call.arguments.question);
  if (question === "")
    return { isError: true, content: [{ type: "text", text: "Send a question." }] };
  const result = await agent(question, tenantOf(call.arguments.tenant));
  return { content: [{ type: "text", text: result.text }] };
}

export async function mcpReply(message: McpMessage, agent: Agent): Promise<McpReply | undefined> {
  if (message.id === undefined) return undefined;
  const reply: McpReply = { jsonrpc: "2.0", id: message.id };
  if (message.method === "initialize") {
    const serverInfo = { name: "hcp-showcase", version: "1.0.0" };
    reply.result = { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo };
  } else if (message.method === "tools/list") {
    reply.result = { tools: toolList() };
  } else if (message.method === "tools/call") {
    reply.result = await callTool(message.params, agent);
  } else {
    reply.error = { code: METHOD_NOT_FOUND, message: "Method not found" };
  }
  return reply;
}

function flagValue(args: string[], flag: string): string {
  const position = args.indexOf(flag);
  if (position === -1 || position + 1 >= args.length) return "";
  return args[position + 1];
}

export async function cliText(args: string[], agent: Agent): Promise<string> {
  const question = flagValue(args, "--question");
  if (question === "") return "Add --question with your question.";
  const result = await agent(question, tenantOf(flagValue(args, "--tenant")));
  return result.text;
}
// #stub
//~ // TODO(surfaces): turn each door's format into a question, call the agent, and turn it back
//~ export async function chatResponse(_request: Request, _agent: Agent): Promise<Response> {
//~   return new Response("Not built yet.", { status: 501 });
//~ }
//~
//~ export async function mcpReply(
//~   _message: McpMessage,
//~   _agent: Agent,
//~ ): Promise<McpReply | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function cliText(_args: string[], _agent: Agent): Promise<string> {
//~   return "Not built yet.";
//~ }
// #endregion

async function mcpResponse(request: Request, agent: Agent): Promise<Response> {
  const reply = await mcpReply((await request.json()) as McpMessage, agent);
  if (reply === undefined) return new Response(null, { status: 202 });
  return Response.json(reply);
}

export async function route(request: Request, agent: Agent): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/") {
    return new Response(BOARD_PAGE, { headers: { "content-type": "text/html" } });
  }
  if (request.method === "POST" && path === "/chat") return chatResponse(request, agent);
  if (request.method === "POST" && path === "/mcp") return mcpResponse(request, agent);
  return new Response("Not found", { status: 404 });
}

export function serve(agent: Agent, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch: (request) => route(request, agent) });
}
