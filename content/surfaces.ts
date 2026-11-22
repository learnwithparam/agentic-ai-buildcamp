import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening:
    "What happens when the team wants the same agent in a browser, a chat tool and a terminal?",
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
  W[Web chat] --> A[One agent]
  M[MCP tool] --> A
  C[Command line] --> A
  A --> R[Router, documents and numbers]
  R --> T[The same answer]`,
  stuck: {
    correct: "Six green badges, and the same answer on every surface.",
    wrong: "Each surface writes its own answer, so they drift apart.",
    hint: "Each door only changes the format. The answer text comes from the agent alone.",
    rows: [
      [
        "The web chat took an empty question.",
        "The chat door does not check the question before it calls the agent.",
        "In chatResponse, return status 400 when the question is empty.",
      ],
      [
        "The tool list is missing ask_team.",
        "The MCP door does not list its tool.",
        "In mcpReply, answer tools/list with the ask_team tool.",
      ],
      [
        "An unknown method did not return an error.",
        "The MCP door answers every method the same way.",
        "In mcpReply, return error code -32601 for a method it does not know.",
      ],
      [
        "The web and MCP answers differ.",
        "One door changes the text before it sends it.",
        "Make each door return result.text from the same agent call, with no extra wording.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the web chat must refuse an empty question",
      find: 'if (question === "") return new Response(',
      replace: 'if (question === "~") return new Response(',
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the MCP door must list its tool",
      find: "reply.result = { tools: toolList() };",
      replace: "reply.result = { tools: [] };",
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the MCP door must report an unknown method",
      find: 'reply.error = { code: METHOD_NOT_FOUND, message: "Method not found" };',
      replace: "reply.result = {};",
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the command line must ask for a question",
      find: 'return "Add --question with your question.";',
      replace: 'return "";',
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "every door must give the same answer",
      find: 'return { content: [{ type: "text", text: result.text }] };',
      replace: 'return { content: [{ type: "text", text: result.text.toUpperCase() }] };',
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "the board page must hold a form",
      find: '<form id="ask">',
      replace: '<div id="ask">',
    },
  ],
};
