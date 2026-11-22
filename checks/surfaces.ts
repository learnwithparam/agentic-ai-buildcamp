// Module 06: the web chat, the MCP tool and the command line all reach the same agent.
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { cliText, serve, TOOL_NAME } from "../packages/core/src/surfaces";
import { type Agent, askTeam } from "../packages/core/src/team";
import { type Check, expect } from "../src/verify";

const NEW_PRESCRIPTIONS = `SELECT territory, SUM(new_prescriptions) AS total
  FROM pharma_a.territory_rx_weekly
  WHERE brand = 'OncoX' AND week_start BETWEEN '2026-07-01' AND '2026-09-30'
  GROUP BY territory ORDER BY total DESC LIMIT 1`;

const AGENT: Agent = (question, tenantId) => {
  const models = {
    generate: async () => "NOT_IN_DOCUMENTS",
    writeQuery: async () => NEW_PRESCRIPTIONS,
  };
  return askTeam(question, tenantId, models);
};

function theCase() {
  const found = HCP_GOLDEN.cases.find((item) => item.name === "top-territory-launch");
  expect(found !== undefined, "The golden set has no case named top-territory-launch.");
  return found;
}

function rightTerritory(): string {
  return String(theCase().truth.territory);
}

async function withServer<Result>(work: (base: string) => Promise<Result>): Promise<Result> {
  const server = serve(AGENT, 0);
  try {
    return await work(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
  }
}

async function chatText(base: string): Promise<string> {
  const body = JSON.stringify({ question: theCase().question });
  const reply = await fetch(`${base}/chat`, { method: "POST", body, signal: WAIT() });
  const data = (await reply.text()).split("data: ")[1];
  return JSON.parse(data).text;
}

type McpAnswer = {
  result: { serverInfo: { name: string }; tools: { name: string }[]; content: { text: string }[] };
  error?: { code: number };
};
const WAIT = AbortSignal.timeout.bind(AbortSignal, 10000);

async function mcpCall(base: string, message: object): Promise<McpAnswer> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, ...message });
  const reply = await fetch(`${base}/mcp`, { method: "POST", body, signal: WAIT() });
  return reply.json();
}

async function mcpText(base: string): Promise<string> {
  const params = { name: TOOL_NAME, arguments: { question: theCase().question } };
  const reply = await mcpCall(base, { method: "tools/call", params });
  return reply.result.content[0].text;
}

async function cliAnswer(): Promise<string> {
  return cliText(["--question", theCase().question], AGENT);
}

export const checks: Check[] = [
  {
    name: "The web chat answers with a server-sent event",
    tryNext: "In chatResponse, send the agent result as one event named answer.",
    run: async () => {
      await withServer(async (base) => {
        const text = await chatText(base);
        expect(text.includes(rightTerritory()), `The web answer is not ${rightTerritory()}.`);
        const empty = await fetch(`${base}/chat`, { method: "POST", body: "{}", signal: WAIT() });
        expect(empty.status === 400, "The web chat took an empty question.");
      });
    },
  },
  {
    name: "The MCP door lists one tool and calls it",
    tryNext: "In mcpReply, handle initialize, tools/list and tools/call.",
    run: async () => {
      await withServer(async (base) => {
        const start = await mcpCall(base, { method: "initialize" });
        expect(start.result.serverInfo.name === "hcp-showcase", "The MCP door has no name.");
        const list = await mcpCall(base, { method: "tools/list" });
        expect(list.result.tools[0].name === TOOL_NAME, "The tool list is missing ask_team.");
        const text = await mcpText(base);
        expect(text.includes(rightTerritory()), `The MCP answer is not ${rightTerritory()}.`);
      });
    },
  },
  {
    name: "The MCP door says so when a method is unknown",
    tryNext: "In mcpReply, return error code -32601 for a method it does not know.",
    run: async () => {
      await withServer(async (base) => {
        const reply = await mcpCall(base, { method: "tools/destroy" });
        expect(reply.error?.code === -32601, "An unknown method did not return an error.");
      });
    },
  },
  {
    name: "The command line answers and asks for a question when it has none",
    tryNext: "In cliText, read the --question flag and call the agent.",
    run: async () => {
      const text = await cliAnswer();
      expect(
        text.includes(rightTerritory()),
        `The command line answer is not ${rightTerritory()}.`,
      );
      const none = await cliText([], AGENT);
      expect(none === "Add --question with your question.", "The command line took no question.");
    },
  },
  {
    name: "All three doors give the same answer",
    tryNext: "Make each door return result.text from the same agent call, with no extra wording.",
    run: async () => {
      await withServer(async (base) => {
        const web = await chatText(base);
        const mcp = await mcpText(base);
        const line = await cliAnswer();
        expect(web === mcp, "The web and MCP answers differ.");
        expect(mcp === line, "The MCP and command line answers differ.");
      });
    },
  },
  {
    name: "The board page has a form that posts to the chat",
    tryNext: "In route, return the board page for GET /.",
    run: async () => {
      await withServer(async (base) => {
        const page = await fetch(base, { signal: WAIT() });
        const html = await page.text();
        expect(page.status === 200 && html.includes("<form"), "The board page has no form.");
        expect(html.includes("/chat"), "The board page does not post to the chat.");
      });
    },
  },
];
