/**
 * Run the citation check, and its one rewrite, on the stored answers that fail it (lesson 21).
 *
 * npm run citations:audit finds the stored answers the check would stop. This script rebuilds each
 * one's conversation (the question, the search results, the answer) and runs the app's own cite
 * node on it, with the real model through the gateway. Each run is a new Langfuse trace, tagged
 * citations-replay, with the cite span and the citations score, exactly as in the app.
 *
 * It writes data/evidence/citations-replay.json: per answer, the problems, the outcome, the
 * rewrite and the search results, so scripts/citations-replay.test.ts can check the outcomes
 * again with no model call. It calls the model once per failing answer.
 *
 *   npm run citations:replay
 *   npm run citations:replay -- --since 30d
 */
import "../src/server/load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { getActiveTraceId, observe, propagateAttributes } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ChatMessage } from "../src/shared/messages";
import { checkCitations, type CitationProblem, type RetrievedSection } from "../src/server/citations";
import { citeNode } from "../src/server/medinfo-agent";
import { scriptUser } from "../src/server/users";
import { loadStoredTurns, traceLink, type StoredTurn } from "./citations-audit";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPLAY_FILE = path.join(ROOT, "data/evidence/citations-replay.json");

export type ReplayedAnswer = {
  storedTrace: string;
  replayTrace: string;
  asked: string;
  answer: string;
  retrieved: RetrievedSection[];
  problems: CitationProblem[];
  outcome: "passed" | "rewritten" | "withheld";
  rewrite: string;
  afterRewrite: CitationProblem[];
};

// The stored turn as the graph state the cite node reads: the question, the agent's search calls
// with their stored queries and results, then the answer. The model refuses a tool result with no
// call that asked for it, so the thread must be the one it really saw.
export function stateOf(turn: StoredTurn, today: string) {
  const calls = turn.searches.map((search, index) => ({ id: `search-${index}`, name: "search_labels", args: { query: search.query } }));
  const messages: ChatMessage[] = [
    { id: "asked", type: "human", content: turn.asked },
    { id: "searching", type: "ai", content: [], tool_calls: calls },
    ...turn.searches.map(
      (search, index): ChatMessage => ({
        id: `result-${index}`,
        type: "tool",
        tool_call_id: calls[index].id,
        name: "search_labels",
        content: JSON.stringify({ ok: true, results: search.results }),
        status: "success"
      })
    ),
    { id: "answer", type: "ai", content: [{ type: "text", text: turn.answer }], tool_calls: [] }
  ];
  return { messages, route: null, dueAt: null, today };
}

const replayOne = observe(
  (turn: StoredTurn) =>
    propagateAttributes(
      { userId: scriptUser().userId, traceName: "citations-replay", tags: ["hcp-medinfo", "citations-replay"], metadata: { storedTrace: turn.traceId } },
      async () => {
        const { outcome } = await citeNode(stateOf(turn, new Date().toISOString().slice(0, 10)), { configurable: { user: scriptUser() } });
        return { outcome, replayTrace: getActiveTraceId() ?? "" };
      }
    ),
  { name: "citations-replay", asType: "agent", captureInput: false, captureOutput: false }
);

async function main() {
  const processor = new LangfuseSpanProcessor();
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  const since = process.argv.indexOf("--since");
  const { turns, projectId } = await loadStoredTurns(since === -1 ? undefined : process.argv[since + 1]);
  const failing = turns.filter((turn) => checkCitations(turn.answer, turn.retrieved, turn.asked).length);
  console.log(`${turns.length} stored answers, ${failing.length} fail the check. Replaying each on the model.`);

  const replayed: ReplayedAnswer[] = [];
  for (const turn of failing) {
    const { outcome, replayTrace } = await replayOne(turn);
    if (!outcome) throw new Error(`The cite node gave no outcome for ${turn.traceId}.`);
    replayed.push({
      storedTrace: turn.traceId,
      replayTrace,
      asked: turn.asked,
      answer: turn.answer,
      retrieved: turn.retrieved,
      problems: outcome.problems,
      outcome: outcome.outcome,
      rewrite: outcome.rewrite ?? "",
      afterRewrite: outcome.afterRewrite
    });
    const kinds = [...new Set(outcome.problems.map((problem) => problem.kind))].join(", ");
    console.log(`\n${outcome.outcome} (${kinds}): ${turn.asked.split("\n").at(-1)?.slice(0, 90)}\n  ${traceLink(projectId, replayTrace)}`);
  }
  await processor.forceFlush();
  await sdk.shutdown();

  const count = (outcome: ReplayedAnswer["outcome"]) => replayed.filter((row) => row.outcome === outcome).length;
  console.log(`\n${replayed.length} replayed: ${count("rewritten")} rewritten, ${count("withheld")} withheld.`);
  mkdirSync(path.dirname(REPLAY_FILE), { recursive: true });
  writeFileSync(REPLAY_FILE, `${JSON.stringify({ ranAt: new Date().toISOString(), answers: replayed }, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, REPLAY_FILE)}.`);
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
