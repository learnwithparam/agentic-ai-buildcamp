// Every surface asks the same agent and shows the same reply.
// A reply is words plus an optional chart. The chart is a json-render spec that any surface draws.
// The words stream out one piece at a time, so a reader sees them as they arrive.
import { toUIMessageStream } from "@ai-sdk/langchain";
import type { Spec } from "@json-render/core";
import { AIMessageChunk } from "@langchain/core/messages";
import { jwtVerify, SignJWT } from "jose";
import { PEOPLE } from "../../../data/catalog/people";
import type { Agent } from "./team";

export const MODEL_NAME = "hcp-team";

export type Reply = { text: string; chart?: Spec };
export type SurfaceAgent = (question: string, person: string) => Promise<Reply>;
export type Row = [label: string, value: number];
export type Sse = { event?: string; data: string };

export const TOOL_NAME = "ask_team";
export const DEFAULT_PERSON = "alice";
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
type Elements = Spec["elements"];

const NO_STYLE = { className: null };

function barElements(rows: Row[]): Elements {
  const biggest = Math.max(1, ...rows.map(([, value]) => value));
  const elements: Elements = {};
  rows.forEach(([label, value], index) => {
    const percent = Math.round((value / biggest) * 100);
    const props = { value: percent, max: 100, label: `${label}: ${value}` };
    elements[`bar-${index}`] = { type: "Progress", props };
  });
  return elements;
}

// One spec holds a bar for each row and a table of the same rows.
export function chartSpec(title: string, rows: Row[], columns = ["Name", "Value"]): Spec {
  const bars = barElements(rows);
  const card = { title, description: null, maxWidth: "md", centered: null, ...NO_STYLE };
  const stack = { direction: "vertical", gap: "sm", align: null, justify: null, ...NO_STYLE };
  const table = {
    columns,
    rows: rows.map(([label, value]) => [label, String(value)]),
    caption: null,
  };
  return {
    root: "card",
    elements: {
      card: { type: "Card", props: card, children: ["bars", "table"] },
      bars: { type: "Stack", props: stack, children: Object.keys(bars) },
      table: { type: "Table", props: table },
      ...bars,
    },
  };
}

// Break the text into words that keep their trailing space, and send each as a model chunk.
async function* wordChunks(text: string): AsyncGenerator<AIMessageChunk> {
  for (const word of text.split(/(?<=\s)/)) yield new AIMessageChunk({ content: word });
}

// The AI SDK turns LangChain chunks into text-delta parts. We keep only the words.
export async function* wordsOf(text: string): AsyncGenerator<string> {
  const parts = toUIMessageStream(wordChunks(text));
  for await (const part of parts) {
    if (part.type === "text-delta") yield part.delta;
  }
}

function contentChunk(content: string) {
  const delta = { content };
  return { object: "chat.completion.chunk", model: MODEL_NAME, choices: [{ index: 0, delta }] };
}

// The events of one chat reply: a word per event, then the chart, then the end marker.
export async function* chatEvents(reply: Reply): AsyncGenerator<Sse> {
  for await (const word of wordsOf(reply.text)) {
    yield { data: JSON.stringify(contentChunk(word)) };
  }
  if (reply.chart !== undefined) yield { event: "chart", data: JSON.stringify(reply.chart) };
  yield { data: "[DONE]" };
}
// #stub
//~ // TODO(surfaces): stream the reply one word per event, then send the chart and the end marker
//~ export async function* chatEvents(reply: Reply): AsyncGenerator<Sse> {
//~   yield { data: JSON.stringify(reply) };
//~ }
//~
//~ export function chartSpec(_title: string, _rows: Row[], _columns?: string[]): Spec {
//~   return { root: "none", elements: {} };
//~ }
// #endregion

// The first board, kept so the sign-in unit still has a door to test. The Hono server replaces it.
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
