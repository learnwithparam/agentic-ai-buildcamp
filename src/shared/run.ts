import { CLAIM_REASONS, type CitationProblem } from "../server/citations";
import type { ChatMessage, ToolMessage } from "./messages";

// Step 2B. The record of how one answer was made, the same steps the trace holds: the tier the
// router chose and why, each search with the sections it returned and their scores, every other
// lookup, and the citation check. The graph keeps one per reply (state.runs, keyed by the reply's
// message id), so the chat can show it under the answer after a reload, not only while it streams.

export type RunHit = { doc_id: string; section: string; score?: number; status: string; country: string };
export type RunLookup = { tool: string; asked: string; hits: RunHit[]; failed: boolean };
export type RunCheck = { outcome: "passed" | "rewritten" | "withheld"; problems: string[] };
export type AnswerRun = { tier: string; reason: string; lookups: RunLookup[]; check: RunCheck | null };

// What a doctor reads for each problem the check found. The model gets the longer feedback in
// describeProblem (src/server/citations.ts); the screen says only what was wrong.
export function plainProblem(problem: CitationProblem): string {
  switch (problem.kind) {
    case "not_retrieved":
      return `cited [${problem.citation}], which no search in this chat found`;
    case "not_in_force":
      return `cited [${problem.citation}], which is ${problem.status} and not in force today`;
    case "uncited":
      return `gave ${problem.quantity} with no citation`;
    case "unsupported":
      return `gave ${problem.quantity}, which ${problem.citations.map((citation) => `[${citation}]`).join(" ")} does not say`;
    case "claim":
      return `claim "${problem.claim}" ${CLAIM_REASONS[problem.reason].plain}`;
  }
}

function hitsIn(result: unknown): RunHit[] {
  if (!result || typeof result !== "object") return [];
  const out = result as { results?: RunHit[]; sections?: RunHit[]; uses?: RunHit[] } & Partial<RunHit>;
  const one = out.doc_id && out.section ? [out as RunHit] : [];
  return [...one, ...(out.results ?? []), ...(out.sections ?? []), ...(out.uses ?? [])].map((hit) => ({
    doc_id: hit.doc_id,
    section: hit.section,
    ...(typeof hit.score === "number" ? { score: hit.score } : {}),
    status: hit.status,
    country: hit.country
  }));
}

// The tool calls since the doctor's latest message, each with what it was asked and found.
export function lookupsOf(messages: ChatMessage[]): RunLookup[] {
  const start = messages.map((message) => message.type).lastIndexOf("human") + 1;
  const turn = messages.slice(start);
  const results = new Map(turn.filter((message): message is ToolMessage => message.type === "tool").map((message) => [message.tool_call_id, message]));
  return turn.flatMap((message) =>
    message.type === "ai"
      ? message.tool_calls.map((call) => {
          const result = results.get(call.id);
          let parsed: unknown;
          try {
            parsed = result ? JSON.parse(result.content) : undefined;
          } catch {
            parsed = undefined;
          }
          const asked = Object.values(call.args).filter((value) => typeof value === "string" && value.trim()).join(", ");
          return { tool: call.name, asked, hits: hitsIn(parsed), failed: !result || result.status === "error" };
        })
      : []
  );
}

export function answerRun(
  messages: ChatMessage[],
  route: { tier: string; reason: string } | null,
  check: { outcome: RunCheck["outcome"]; problems: CitationProblem[] } | null
): AnswerRun {
  return {
    tier: route?.tier ?? "none",
    reason: route?.reason ?? "",
    lookups: lookupsOf(messages),
    check: check ? { outcome: check.outcome, problems: check.problems.map(plainProblem) } : null
  };
}
