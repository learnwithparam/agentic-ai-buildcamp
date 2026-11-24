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

export type CaseExpectation = { idealAnswer: string; expectedBehavior: Behavior };

export type CaseItem = {
  id: string;
  input: CaseInput;
  expectedOutput: CaseExpectation;
  metadata: { caseId: string; slice: string; chapter: string; riskTier: string; split: string; showcase?: string };
};

type RawCase = {
  description: string;
  vars: Record<string, string>;
  metadata: { slice: string; chapter: string; riskTier: string; split: string; expectedBehavior: Behavior; showcase?: string; idealAnswer: string };
};

const CASES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/hcp/evals/medinfo.yaml");

export function loadMedinfoCases(): CaseItem[] {
  const config = parse(readFileSync(CASES_FILE, "utf8")) as { defaultTest: { vars: Record<string, string> }; tests: RawCase[] };
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
      expectedOutput: { idealAnswer, expectedBehavior },
      metadata: { caseId, ...tags }
    };
  });
}
