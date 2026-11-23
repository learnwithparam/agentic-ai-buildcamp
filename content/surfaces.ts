import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens when the team wants one agent and its chart on the web and in a terminal?",
  production:
    "A field team uses a browser. An analyst uses a chat tool. An engineer uses a terminal.",
  terms: [
    {
      id: "surface",
      word: "surface",
      meaning: "A place where people reach the agent, such as a web page or a command line.",
    },
    {
      id: "mcp",
      word: "MCP",
      meaning: "A shared way for chat tools to call your tools.",
    },
    {
      id: "server-sent-event",
      word: "server-sent event",
      meaning: "A message the server pushes to a web page over one open request.",
    },
  ],
  picture: `flowchart LR
  W[Web chat] --> S[Hono server]
  M[MCP tool] --> S
  C[Ink terminal] --> S
  S --> A[One agent]
  A --> R[Words and a chart spec]
  R --> T[The same answer on every surface]`,
  stuck: {
    correct: "Seven green badges, and the same answer on every surface.",
    wrong: "Each surface writes its own answer, so they drift apart.",
    hint: "Each door only changes the format. The words and the chart come from the agent alone.",
    rows: [
      [
        "The stream sent one event, so nothing streamed.",
        "The server waited for the whole reply and sent it at the end.",
        "In chatEvents, send one event for each word.",
      ],
      [
        "The MCP answer differs from the web answer.",
        "One door changes the text before it sends it.",
        "Return reply.text from the same agent call on every surface.",
      ],
      [
        "The tool list is missing ask_team.",
        "The MCP door does not register its tool.",
        "In mcpServer, register the ask_team tool.",
      ],
      [
        "The terminal frame changed:",
        "The terminal draws the bars or the table in a new way.",
        "In ReplyView, draw one bar for each Progress part.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the reply must stream in many events, not one",
      find: "for (const word of text.split(/(?<=\\s)/))",
      replace: "for (const word of [text])",
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the chart must follow the words",
      find: "if (reply.chart !== undefined) yield",
      replace: "if (reply.chart === undefined) yield",
    },
    {
      file: "packages/core/src/server.ts",
      rule: "MCP must give the same words as the web",
      find: 'const content = [{ type: "text" as const, text: reply.text }];',
      replace: 'const content = [{ type: "text" as const, text: reply.text.toUpperCase() }];',
    },
    {
      file: "packages/core/src/server.ts",
      rule: "the chat route must refuse an empty question",
      find: 'if (question === "") return context.json',
      replace: 'if (question === "~") return context.json',
    },
    {
      file: "packages/core/src/server.ts",
      rule: "sign-in must stay a stub until access control",
      find: 'access-control module." }, 501)',
      replace: 'access-control module." }, 200)',
    },
    {
      file: "packages/core/src/cli.tsx",
      rule: "the terminal must draw the bars",
      find: '"█".repeat(',
      replace: '"".repeat(',
    },
    {
      file: "packages/core/src/web.tsx",
      rule: "the web page must draw the chart bars",
      find: "Progress: shadcnComponents.Progress,",
      replace: "Progress: shadcnComponents.Text,",
    },
    {
      file: "config/goose.yaml",
      rule: "Goose must point at the MCP route",
      find: "uri: http://localhost:3000/mcp",
      replace: "uri: http://localhost:3000/chat",
    },
  ],
};
