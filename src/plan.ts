// The approved plan, as data. A unit is done only when a real run left evidence for it.
// Evidence is a file in evidence/ written by: bun run verify <slug> with LLM_PROVIDER=gateway.
// It holds the hash of the unit's files, so a change to the code makes the evidence stale.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STACK } from "./stack";

export type Plan = { files: string[]; lines: string[] };
export type Evidence = {
  slug: string;
  hash: string;
  passed: string[];
  costUsd: number;
  traces: string[];
};

const COMMON = ["real run on the gateway", "bite proof", "checkpoint prove"];

export const PLAN: Record<string, Plan> = {
  foundation: {
    files: ["infra/docker-compose.yml", "scripts/seed.ts", "scripts/up.ts"],
    lines: ["three containers healthy", "seed twice gives the same bytes", "naive scoreboard"],
  },
  "gateway-tracing": {
    files: [
      "config/models.ts",
      "scripts/gateway-config.ts",
      "infra/litellm.yaml",
      "packages/core/src/ask.ts",
      "packages/core/src/telemetry.ts",
    ],
    lines: ["a call per role has a cost", "one nested trace in Phoenix", "fallback to backup"],
  },
  "documents-freshness": {
    files: ["packages/core/src/ingestion.ts"],
    lines: ["one active version", "unchanged_skipped", "scan read by the vision role"],
  },
  "intent-routing": {
    files: ["packages/core/src/router.ts"],
    lines: ["templated routes have no retrieval span", "route decision in the trace"],
  },
  "grounded-answer": {
    files: ["packages/core/src/grounded.ts"],
    lines: ["citations match the catalog", "unanswerable refuses", "wrong dose caught"],
  },
  "agent-loop": {
    files: ["packages/core/src/agent.ts"],
    lines: ["three hops with two tool calls", "MAX_TURNS stops a loop"],
  },
  "langgraph-agent": {
    files: ["packages/core/src/agent-graph.ts"],
    lines: ["three hops as a graph", "kill and resume on the same thread", "recursion limit"],
  },
  "analytics-mcp": {
    files: ["packages/core/src/mcp-bi.ts"],
    lines: [
      "client lists the tools",
      "valid chart spec on both schemas",
      "no row in any span",
      "select star refused",
      "sandbox time and memory caps",
    ],
  },
  surfaces: {
    files: [
      "packages/core/src/surfaces.ts",
      "packages/core/src/server.ts",
      "packages/core/src/cli.tsx",
      "packages/core/src/web.tsx",
    ],
    lines: [
      "web chart in Agent Chat UI",
      "chart in bun run chat",
      "MCP Inspector lists and calls tools",
      "Goose answers over /mcp",
      "more than one SSE event",
    ],
  },
  "access-control": {
    files: ["packages/core/src/access.ts"],
    lines: [
      "can and RLS agree for every user",
      "wrong password refused",
      "tampered cookie refused",
      "cross tenant query refused by Postgres",
    ],
  },
  "approvals-memory": {
    files: ["packages/core/src/approvals.ts"],
    lines: [
      "approve on the web card after restart",
      "approve from the CLI",
      "no memory across tenants",
    ],
  },
  "guardrails-workers": {
    files: ["packages/core/src/guardrails.ts", "packages/core/src/jobs.ts"],
    lines: [
      "ten events give one run",
      "kill -9 resumes",
      "poison job in the DLQ",
      "run over the cap refused",
    ],
  },
  "release-gate": {
    files: ["packages/core/src/gate.ts", "scripts/eval.ts"],
    lines: ["24 of 24 live", "planted regression fails the gate", "experiment in Phoenix"],
  },
  "research-knowledge": {
    files: ["apps/product-teammates/src/capture.ts"],
    lines: ["price change found", "unchanged page skipped", "trivia redirected"],
  },
  "product-intelligence-bi": {
    files: ["apps/product-teammates/src/analyst.ts"],
    lines: ["handoff in the trace", "bar chart in UI and CLI", "no email in any span"],
  },
  "tenancy-and-memory": {
    files: ["apps/product-teammates/src/workspace.ts"],
    lines: ["priya cannot see the memo", "memory stays in its workspace", "approval resumes"],
  },
  "always-on-teammates": {
    files: ["apps/product-teammates/src/always-on.ts"],
    lines: ["event to run to approve", "debounce", "crash resume", "24 of 24 live"],
  },
};

export function evidencePath(root: string, slug: string): string {
  return join(root, "evidence", `${slug}.json`);
}

// A short fingerprint of the unit's files. Any edit changes it.
export function hashOf(root: string, slug: string): string {
  const sum = createHash("sha256");
  for (const file of PLAN[slug].files) {
    const full = join(root, file);
    sum.update(file).update(existsSync(full) ? readFileSync(full) : "missing");
  }
  return sum.digest("hex");
}

// Why a unit is not done yet, or null when it is done.
export function redReason(root: string, slug: string): string | null {
  const plan = PLAN[slug];
  const missing = plan.files.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) return `no file: ${missing.join(", ")}`;
  const path = evidencePath(root, slug);
  if (!existsSync(path)) return "no evidence from a real run";
  const evidence = JSON.parse(readFileSync(path, "utf8")) as Evidence;
  if (evidence.hash !== hashOf(root, slug)) return "evidence is stale, the code changed";
  const wanted = [...plan.lines, ...COMMON];
  const absent = wanted.filter((line) => !evidence.passed.includes(line));
  if (absent.length > 0) return `lines not passed: ${absent.join("; ")}`;
  if (!(evidence.costUsd > 0)) return "no cost recorded, so no real model call";
  if (evidence.traces.length === 0) return "no Phoenix trace id";
  const used = STACK.filter((row) => row.unit === slug);
  const unread = used.filter(
    (row) => !readFileSync(join(root, row.file), "utf8").includes(row.pkg),
  );
  if (unread.length > 0) return `not imported: ${unread.map((row) => row.pkg).join(", ")}`;
  return null;
}
