/**
 * The medinfo cases from the dataset repo copy (data/hcp/evals/medinfo.yaml), shaped as
 * Langfuse dataset items. This is the only place the buildcamp reads them, so the
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
};

// The dataset repo's exact checks on the answer text. llm-rubric checks are left out:
// the correctness judge in run-dataset.ts covers meaning.
export type TextCheck = { type: "contains" | "not-contains" | "regex" | "not-regex"; value: string };
const TEXT_CHECKS = new Set<string>(["contains", "not-contains", "regex", "not-regex"]);

export type CaseExpectation = { idealAnswer: string; expectedBehavior: Behavior; checks: TextCheck[] };

export type CaseItem = {
  id: string;
  input: CaseInput;
  expectedOutput: CaseExpectation;
  metadata: { caseId: string; slice: string; chapter: string; riskTier: string; split: string; showcase?: string };
};

type RawAssert = { type: string; value: string };

type RawCase = {
  description: string;
  vars: Record<string, string>;
  assert?: RawAssert[];
  metadata: { slice: string; chapter: string; riskTier: string; split: string; expectedBehavior: Behavior; showcase?: string; idealAnswer: string };
};

const CASES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/hcp/evals/medinfo.yaml");

export function loadMedinfoCases(): CaseItem[] {
  const config = parse(readFileSync(CASES_FILE, "utf8")) as {
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
        messages: [{ role: "user", content: vars.query }],
        tenantId: vars.tenantId,
        brandId: vars.brandId,
        country: vars.country
      },
      expectedOutput: {
        idealAnswer,
        expectedBehavior,
        checks: [...(config.defaultTest.assert ?? []), ...(test.assert ?? [])].filter((check): check is TextCheck =>
          TEXT_CHECKS.has(check.type)
        )
      },
      metadata: { caseId, ...tags }
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
