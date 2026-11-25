/**
 * The cases from the dataset repo copy (data/hcp/evals), shaped as Langfuse dataset items:
 * medinfo.yaml for the medical information desk, and, from lesson 14, fact-check.yaml and
 * outreach.yaml for the two agents built on the same base, from lesson 15, a2a.yaml for the
 * hand-off between them, from lesson 16, events.yaml for the event handlers, and, from lesson 17,
 * autonomy.yaml for the nightly sweep, and, from lesson 22, insights.yaml for the sales questions. Each item says which agent answers it. This is the only place the buildcamp reads them, so the
 * dataset in Langfuse is always the pinned dataset repo, never a hand-typed copy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ConversationLine } from "../src/server/medinfo-agent";

export const BEHAVIORS = ["defer_question", "reply", "ask_follow_up"] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export type CaseInput = {
  messages: ConversationLine[];
  tenantId: string;
  brandId: string;
  country: string;
  // Lesson 16: an event case names a fixture event and which delivery of it this is.
  event?: { eventId: string; delivery: number };
  // Lesson 17: a sweep case names the day it runs on and the limits it starts with.
  sweep?: { today: string; budgetUsd: number; spentUsd: number; paused: boolean; instruction?: string };
  // Lesson 22: who asks a sales question, an analyst or a doctor who must be turned away.
  role?: "analyst" | "doctor";
};

// The dataset repo's exact checks on the answer text. llm-rubric checks are left out:
// the faithfulness judge (scripts/judge/faithfulness.ts) covers the slices that need one.
export type TextCheck = { type: "contains" | "not-contains" | "regex" | "not-regex"; value: string };
const TEXT_CHECKS = new Set<string>(["contains", "not-contains", "regex", "not-regex"]);

export type CaseExpectation = { idealAnswer: string; expectedBehavior: Behavior; checks: TextCheck[] };

export const AGENTS = ["medinfo", "fact-check", "outreach", "a2a", "events", "autonomy", "insights"] as const;
export type AgentName = (typeof AGENTS)[number];

export type CaseItem = {
  id: string;
  input: CaseInput;
  expectedOutput: CaseExpectation;
  metadata: { caseId: string; agent: AgentName; slice: string; chapter: string; riskTier: string; split: string; showcase?: string };
};

type RawAssert = { type: string; value: string };

type RawCase = {
  description: string;
  vars: Record<string, string>;
  assert?: RawAssert[];
  metadata: { slice: string; chapter: string; riskTier: string; split: string; expectedBehavior: Behavior; showcase?: string; idealAnswer?: string };
};

const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/hcp/evals");

export function loadMedinfoCases(): CaseItem[] {
  return loadCases("medinfo");
}

// Every case of every agent, in the order the scoreboard lists their slices.
export function loadAllCases(): CaseItem[] {
  return AGENTS.flatMap(loadCases);
}

export function loadCases(agent: AgentName): CaseItem[] {
  const config = parse(readFileSync(path.join(EVALS, `${agent}.yaml`), "utf8")) as {
    defaultTest: { vars: Record<string, string>; assert?: RawAssert[] };
    tests: RawCase[];
  };
  return config.tests.map((test) => {
    const caseId = test.description.match(/^\[([A-Z0-9-]+)\]/)?.[1];
    if (!caseId) throw new Error(`A case has no [ID]: ${test.description}`);
    const vars = { ...config.defaultTest.vars, ...test.vars };
    const { expectedBehavior, idealAnswer, ...tags } = test.metadata;
    return {
      id: `hcp-${caseId.toLowerCase()}`,
      input: {
        // An event case has no question: what the decision model reads is the event itself. A
        // sweep case's question is the instruction a person added to the run, often none.
        messages: [{ role: "user", content: agent === "autonomy" ? vars.query || `Run the nightly sweep for ${vars.today}.` : (vars.query ?? `Event ${vars.event} (delivery ${vars.delivery}).`) }],
        tenantId: vars.tenantId,
        brandId: vars.brandId,
        country: vars.country,
        ...(vars.event ? { event: { eventId: vars.event, delivery: Number(vars.delivery ?? "1") } } : {}),
        ...(agent === "autonomy"
          ? { sweep: { today: vars.today, budgetUsd: Number(vars.budgetUsd), spentUsd: Number(vars.spentUsd), paused: vars.paused === "yes", ...(vars.query ? { instruction: vars.query } : {}) } }
          : {}),
        ...(agent === "insights" ? { role: vars.role === "analyst" ? ("analyst" as const) : ("doctor" as const) } : {})
      },
      expectedOutput: {
        // The two content agents' cases have no ideal answer: their codes and citations are the answer.
        idealAnswer: idealAnswer ?? "",
        expectedBehavior,
        checks: [...(config.defaultTest.assert ?? []), ...(test.assert ?? [])].filter((check): check is TextCheck =>
          TEXT_CHECKS.has(check.type)
        )
      },
      metadata: { caseId, agent, ...tags }
    };
  });
}

// The checks write doses as "2.5mg" and ranges as "20 to 25". The agent writes "**2.5 mg**"
// and "20–25", so bold marks go, the space before "mg" goes, and a dash between two numbers
// becomes " to ". Nothing else is changed.
export function normalizeAnswer(answer: string) {
  return answer
    .replaceAll("**", "")
    .replace(/(\d)\s+mg\b/g, "$1mg")
    .replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2");
}

// The checks an answer fails, matched the way promptfoo matches them in the dataset repo.
export function failedChecks(answer: string, checks: TextCheck[]): string[] {
  const text = normalizeAnswer(answer);
  return checks
    .filter((check) => {
      if (check.type === "contains") return !text.includes(check.value);
      if (check.type === "not-contains") return text.includes(check.value);
      if (check.type === "not-regex") return new RegExp(check.value).test(text);
      return !new RegExp(check.value).test(text);
    })
    .map((check) => `${check.type} ${check.value}`);
}
