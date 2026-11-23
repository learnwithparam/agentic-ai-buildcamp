// The tech stack the course promised, as data. A test reads this list.
// A row says: this package, at this exact version, is imported by this file.
// Nobody swaps a row for simpler code. A change to a row needs a yes from the course owner.

export type StackRow = { pkg: string; version: string; unit: string; file: string };

export const STACK: StackRow[] = [
  { pkg: "pdf-lib", version: "1.17.1", unit: "foundation", file: "scripts/seed.ts" },
  {
    pkg: "@ai-sdk/openai",
    version: "4.0.116",
    unit: "gateway-tracing",
    file: "config/models.ts",
  },
  { pkg: "ai", version: "7.0.171", unit: "gateway-tracing", file: "packages/core/src/ask.ts" },
  {
    pkg: "@xberg-io/xberg",
    version: "1.3.10",
    unit: "documents-freshness",
    file: "packages/core/src/ingestion.ts",
  },
  {
    pkg: "@langchain/langgraph",
    version: "1.7.4",
    unit: "intent-routing",
    file: "packages/core/src/router.ts",
  },
  {
    pkg: "@langchain/langgraph",
    version: "1.7.4",
    unit: "langgraph-agent",
    file: "packages/core/src/agent-graph.ts",
  },
  {
    pkg: "@langchain/langgraph-checkpoint-postgres",
    version: "1.1.3",
    unit: "langgraph-agent",
    file: "packages/core/src/agent-graph.ts",
  },
  {
    pkg: "@modelcontextprotocol/sdk",
    version: "1.32.2",
    unit: "analytics-mcp",
    file: "packages/core/src/mcp-bi.ts",
  },
  {
    pkg: "@opencoredev/sandbox-sdk",
    version: "1.0.3",
    unit: "analytics-mcp",
    file: "packages/core/src/mcp-bi.ts",
  },
  {
    pkg: "@sebastianwessel/quickjs",
    version: "3.1.0",
    unit: "analytics-mcp",
    file: "packages/core/src/mcp-bi.ts",
  },
  {
    pkg: "@json-render/core",
    version: "0.22.0",
    unit: "analytics-mcp",
    file: "packages/core/src/mcp-bi.ts",
  },
  { pkg: "hono", version: "4.13.17", unit: "surfaces", file: "packages/core/src/server.ts" },
  {
    pkg: "@ai-sdk/langchain",
    version: "3.0.166",
    unit: "surfaces",
    file: "packages/core/src/surfaces.ts",
  },
  {
    pkg: "@json-render/shadcn",
    version: "0.22.0",
    unit: "surfaces",
    file: "packages/core/src/web.tsx",
  },
  { pkg: "ink", version: "8.0.0", unit: "surfaces", file: "packages/core/src/cli.tsx" },
  { pkg: "react", version: "19.3.1", unit: "surfaces", file: "packages/core/src/cli.tsx" },
  { pkg: "jose", version: "6.2.16", unit: "access-control", file: "packages/core/src/access.ts" },
  {
    pkg: "pg-boss",
    version: "12.38.1",
    unit: "guardrails-workers",
    file: "packages/core/src/jobs.ts",
  },
  {
    pkg: "@arizeai/phoenix-client",
    version: "7.18.2",
    unit: "release-gate",
    file: "packages/core/src/gate.ts",
  },
  {
    pkg: "@browserbasehq/stagehand",
    version: "4.4.0",
    unit: "research-knowledge",
    file: "apps/product-teammates/src/capture.ts",
  },
  { pkg: "playwright", version: "1.65.0", unit: "surfaces", file: "scripts/shots.ts" },
];

// Left out on purpose. A test fails if one of these appears in package.json.
export const LEFT_OUT = ["@openfga/sdk", "langfuse", "keycloak-js", "@chat-adapter/slack"];
