// Module 08: one hybrid question works on three surfaces. The web streams it, an MCP client
// calls it and the terminal draws it. The agent here is a replay: it answers from the catalog.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { weeklyTotal } from "../data/catalog/analytics";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { TERRITORIES } from "../data/catalog/prescribers";
import { askServer, barsOf, frameOf } from "../packages/core/src/cli";
import { type Deps, startServer } from "../packages/core/src/server";
import { chartSpec, type Reply, type Row, TOOL_NAME } from "../packages/core/src/surfaces";
import { chartPage } from "../packages/core/src/web";
import { type Check, expect } from "../src/verify";

const WAIT = () => AbortSignal.timeout(10000);
const COLUMNS = ["Territory", "New prescriptions"];

function theCase() {
  const found = HCP_GOLDEN.cases.find((item) => item.name === "top-territory-launch");
  expect(found !== undefined, "The golden set has no case named top-territory-launch.");
  return found;
}

function rows(): Row[] {
  const total = (name: string) => weeklyTotal("OncoX", name, "2026-07-06", "2026-09-28");
  return TERRITORIES.map((name): Row => [name, total(name)]).sort(
    (first, second) => second[1] - first[1],
  );
}

// The replay: the words and chart a good agent gives for the hybrid question.
function replay(): Reply {
  const leader = String(theCase().truth.territory);
  const text = `${leader} led OncoX new prescriptions from July to September 2026.`;
  return { text, chart: chartSpec("OncoX new prescriptions", rows(), COLUMNS) };
}

const DEPS: Deps = {
  agent: async () => replay(),
  pending: async () => [
    {
      id: 7,
      requester: "alice",
      topic: "adverse-events",
      question: "q",
      status: "pending",
      decided_by: null,
    },
  ],
  resume: async (id, decision) => ({ text: `Thread ${id}: ${decision}.` }),
};

async function withServer<Result>(work: (base: string) => Promise<Result>): Promise<Result> {
  const server = startServer(DEPS, 0);
  try {
    return await work(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
  }
}

type Seen = { words: string[]; chartEvents: number; reads: number; ended: boolean };

// Read the stream the way a browser does: one network read at a time, counting events.
async function readStream(base: string): Promise<Seen> {
  const body = JSON.stringify({ messages: [{ role: "user", content: theCase().question }] });
  const reply = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body,
    signal: WAIT(),
  });
  expect(reply.status === 200, `The chat stream answered ${reply.status}.`);
  const seen: Seen = { words: [], chartEvents: 0, reads: 0, ended: false };
  let pending = "";
  for await (const piece of reply.body as ReadableStream<Uint8Array>) {
    seen.reads += 1;
    pending += new TextDecoder().decode(piece);
    const blocks = pending.split("\n\n");
    pending = blocks.pop() ?? "";
    for (const block of blocks) takeBlock(block, seen);
  }
  return seen;
}

function takeBlock(block: string, seen: Seen): void {
  if (block.includes("data: [DONE]")) seen.ended = true;
  else if (block.includes("event: chart")) seen.chartEvents += 1;
  else seen.words.push(JSON.parse(block.split("data: ")[1]).choices[0].delta.content);
}

function wordsIn(stream: string): string {
  const seen: Seen = { words: [], chartEvents: 0, reads: 0, ended: false };
  for (const block of stream.split("\n\n").filter((item) => item !== "")) takeBlock(block, seen);
  return seen.words.join("");
}

async function terminalWords(base: string): Promise<string> {
  let text = "";
  for await (const event of askServer(base, theCase().question, "alice")) {
    if (event.kind === "word") text += event.text;
  }
  return text;
}

async function mcpCall(base: string) {
  const client = new Client({ name: "check", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const tools = await client.listTools();
    const called = await client.callTool({
      name: TOOL_NAME,
      arguments: { question: theCase().question },
    });
    return { tools, called };
  } finally {
    await client.close();
  }
}

const COLOUR_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripColour(text: string): string {
  return text.replace(COLOUR_CODE, "");
}

// A fixed chart keeps the terminal snapshot steady.
const FIXED = chartSpec(
  "Fixed",
  [
    ["North", 40],
    ["South", 20],
    ["East", 10],
  ],
  ["Region", "Value"],
);

const SNAPSHOT = [
  "North led.",
  "",
  "North: 40 ██████████████████████████████",
  "South: 20 ███████████████",
  "East: 10  ████████",
  "",
  "Region  Value",
  "──────  ─────",
  "North   40",
  "South   20",
  "East    10",
].join("\n");

async function colouredFrame(): Promise<string> {
  const load = `import { frameOf } from "./packages/core/src/cli";`;
  const code = `${load} console.log(frameOf("x", undefined));`;
  const env = { ...process.env };
  env.FORCE_COLOR = "1";
  const run = Bun.spawn(["bun", "-e", code], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return new Response(run.stdout).text();
}

export const checks: Check[] = [
  {
    name: "The web chat streams more than one event before the end",
    tryNext: "In chatEvents, send one event for each word, then the chart, then [DONE].",
    run: async () => {
      await withServer(async (base) => {
        const seen = await readStream(base);
        expect(seen.words.length > 1, "The stream sent one event, so nothing streamed.");
        expect(seen.words.join("") === replay().text, "The streamed words are not the reply.");
        expect(seen.chartEvents === 1, "The stream did not send the chart.");
        expect(seen.ended, "The stream did not end with [DONE].");
      });
    },
  },
  {
    name: "The same hybrid question gives the same answer on the web, MCP and terminal",
    tryNext: "Make every surface show the reply from the one agent, with no extra wording.",
    run: async () => {
      await withServer(async (base) => {
        const leader = String(theCase().truth.territory);
        const web = (await readStream(base)).words.join("");
        const { called } = await mcpCall(base);
        const parts = called.content as { text: string }[];
        const terminal = await terminalWords(base);
        expect(web.includes(leader), `The web answer is not ${leader}.`);
        expect(parts[0].text === web, "The MCP answer differs from the web answer.");
        expect(terminal === web, "The terminal answer differs from the web answer.");
        expect(parts[1].text === JSON.stringify(replay().chart), "The MCP chart differs.");
      });
    },
  },
  {
    name: "MCP lists one tool and calls it over Streamable HTTP",
    tryNext: "In mcpServer, register the ask_team tool and answer from the agent.",
    run: async () => {
      await withServer(async (base) => {
        const { tools } = await mcpCall(base);
        expect(tools.tools.length === 1, "The MCP door did not list exactly one tool.");
        expect(tools.tools[0].name === TOOL_NAME, "The tool list is missing ask_team.");
      });
    },
  },
  {
    name: "The web page draws the chart with json-render",
    tryNext: "In chartPage, render the spec with the shadcn parts.",
    run: async () => {
      const page = chartPage("check", replay().chart ?? FIXED);
      const leader = String(theCase().truth.territory);
      expect(page.includes('role="progressbar"'), "The web page has no chart bars.");
      expect(page.includes(leader), `The web page does not show ${leader}.`);
    },
  },
  {
    name: "The terminal draws the chart and table, and matches its snapshot",
    tryNext: "In ReplyView, draw one bar for each Progress part and a table for the Table part.",
    run: async () => {
      expect(barsOf(FIXED).length === 3, "The terminal found the wrong number of bars.");
      const frame = stripColour(frameOf("North led.", FIXED));
      expect(frame === SNAPSHOT, `The terminal frame changed:\n${frame}`);
      const coloured = await colouredFrame();
      expect(coloured.includes("\u001b[32m"), "The terminal reply has no colour.");
    },
  },
  {
    name: "The server refuses an empty question and serves the other routes",
    tryNext: "In buildApp, add resume, pending approvals and the sign-in stub.",
    run: async () => {
      await withServer(async (base) => {
        const post = (path: string, body: object) =>
          fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), signal: WAIT() });
        expect(
          (await post("/v1/chat/completions", { messages: [] })).status === 400,
          "Empty took.",
        );
        expect((await post("/v1/sign-in", {})).status === 501, "Sign-in is not a stub.");
        const bad = await post("/v1/threads/t1/resume", { decision: "maybe" });
        expect(bad.status === 400, "Resume took a decision it does not know.");
        const resumed = await post("/v1/threads/t1/resume", { decision: "approve" });
        const said = wordsIn(await resumed.text());
        expect(said === "Thread t1: approve.", `Resume said "${said}".`);
        const list = await fetch(`${base}/v1/approvals/pending`, { signal: WAIT() });
        expect(((await list.json()) as unknown[]).length === 1, "Pending approvals are missing.");
      });
    },
  },
  {
    name: "The Goose config points at the MCP route",
    tryNext: "In config/goose.yaml, set the extension uri to http://localhost:3000/mcp.",
    run: async () => {
      const text = readFileSync(join(import.meta.dir, "..", "config", "goose.yaml"), "utf8");
      expect(text.includes("type: streamable_http"), "The Goose config is not Streamable HTTP.");
      expect(text.includes("/mcp"), "The Goose config does not point at /mcp.");
    },
  },
];
