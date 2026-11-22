// Three doors lead to one agent: a web chat, an MCP tool and a command line.
// Each door only turns its own format into a question and back. The answer is always the same.
// Until sign-in is on, a door trusts the person named in the request. That is for local use only.
import { jwtVerify, SignJWT } from "jose";
import { PEOPLE } from "../../../data/catalog/people";
import type { Agent } from "./team";

export const TOOL_NAME = "ask_team";
const DEFAULT_PERSON = "alice";
const PROTOCOL_VERSION = "2025-03-26";
const METHOD_NOT_FOUND = -32601;

type ChatBody = { question?: unknown; person?: unknown };
type ToolCall = { name?: string; arguments?: ChatBody };
export type McpMessage = { id?: number | string; method?: string; params?: ToolCall };
export type McpReply = { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: unknown };

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

function personOf(value: unknown): string {
  const person = textOf(value);
  if (person === "") return DEFAULT_PERSON;
  return person;
}

const BOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Medical affairs team</title></head>
<body>
<h1>Ask the medical affairs team</h1>
<form id="ask"><select id="person"><option>alice</option><option>bob</option>
<option>carol</option><option>dr-reviewer</option></select>
<input id="question" size="60" placeholder="Ask about a label or a territory">
<button>Ask</button></form>
<pre id="answer"></pre>
<script>
document.getElementById("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = document.getElementById("question").value;
  const person = document.getElementById("person").value;
  const login = await fetch("/login", { method: "POST", body: JSON.stringify({ person }) });
  const token = (await login.json()).token;
  const headers = { authorization: "Bearer " + token };
  const body = JSON.stringify({ question });
  const reply = await fetch("/chat", { method: "POST", headers, body });
  const text = await reply.text();
  document.getElementById("answer").textContent = JSON.parse(text.split("data: ")[1]).text;
});
</script></body></html>`;

// #region step:surfaces
export async function chatResponse(request: Request, agent: Agent): Promise<Response> {
  const body = (await request.json()) as ChatBody;
  const question = textOf(body.question);
  if (question === "") return new Response("Send a question.", { status: 400 });
  const result = await agent(question, personOf(body.person));
  const event = `event: answer\ndata: ${JSON.stringify(result)}\n\n`;
  return new Response(event, { headers: { "content-type": "text/event-stream" } });
}

function toolList(): unknown[] {
  const properties = { question: { type: "string" }, person: { type: "string" } };
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
  const result = await agent(question, personOf(call.arguments.person));
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
  const result = await agent(question, personOf(flagValue(args, "--person")));
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

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET ?? "dev-secret-for-local-use-only");

// #region step:access-control
function knownPerson(name: string): boolean {
  return PEOPLE.some((person) => person.name === name);
}

export async function signToken(person: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(person)
    .setExpirationTime("2h")
    .sign(SECRET);
}

// Reads the signed token from the request. A missing, forged or expired token gives nobody.
export async function personFrom(request: Request): Promise<string | undefined> {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return undefined;
  try {
    const { payload } = await jwtVerify(header.slice("Bearer ".length), SECRET);
    if (payload.sub === undefined || !knownPerson(payload.sub)) return undefined;
    return payload.sub;
  } catch {
    return undefined;
  }
}

// A local sign-in with no password. A real product checks a password or a single sign-on here.
export async function loginResponse(request: Request): Promise<Response> {
  const body = (await request.json()) as ChatBody;
  const person = textOf(body.person);
  if (!knownPerson(person)) return new Response("Nobody has that name.", { status: 404 });
  return Response.json({ token: await signToken(person) });
}
// #stub
//~ // TODO(access-control): sign a token at login and read the person back from the next request
//~ export async function personFrom(_request: Request): Promise<string | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function loginResponse(_request: Request): Promise<Response> {
//~   return new Response("Not built yet.", { status: 501 });
//~ }
// #endregion

async function mcpResponse(request: Request, agent: Agent): Promise<Response> {
  const reply = await mcpReply((await request.json()) as McpMessage, agent);
  if (reply === undefined) return new Response(null, { status: 202 });
  return Response.json(reply);
}

function actingAs(agent: Agent, person: string | undefined): Agent {
  if (person === undefined) return agent;
  return (question) => agent(question, person);
}

export async function route(request: Request, agent: Agent, signIn = false): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/") {
    return new Response(BOARD_PAGE, { headers: { "content-type": "text/html" } });
  }
  if (request.method === "POST" && path === "/login") return loginResponse(request);
  if (request.method !== "POST" || (path !== "/chat" && path !== "/mcp")) {
    return new Response("Not found", { status: 404 });
  }
  const person = await personFrom(request);
  if (signIn && person === undefined) return new Response("Sign in first.", { status: 401 });
  const caller = actingAs(agent, person);
  if (path === "/chat") return chatResponse(request, caller);
  return mcpResponse(request, caller);
}

export function serve(agent: Agent, port: number, signIn = false): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch: (request) => route(request, agent, signIn) });
}
