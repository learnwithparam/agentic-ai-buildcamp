/**
 * An agent that runs offline: `npm run evals:measure -- --fake`. It calls no model. It decides a
 * case from the prompt text and the case's own data, so the measure's arithmetic, its file and the
 * sabotage verdict can be proved without a key. Its numbers are not the agent's, and the file it
 * writes says so.
 *
 * A case needs the citation rule when one of its checks wants a [doc_id, section] bracket, and the
 * defer rules when its expected behavior is to decline. A prompt without the rule fails those cases,
 * which is what the real agent does when the rule is gone, and what the sabotage run looks for.
 */
import { hasCitationRule, hasDeferRule } from "./eval-sabotage";
import type { CaseItem } from "./hcp-cases";

export const needsCitation = (item: CaseItem) => item.expectedOutput.checks.some((check) => check.type === "regex" && check.value.startsWith("\\["));
export const needsDefer = (item: CaseItem) => item.expectedOutput.expectedBehavior === "defer_question";

// `flaky` names cases that fail on one run in `flakyRun`, so pass^k shows what pass@1 hides.
export function scriptedPass(item: CaseItem, prompt: string, run: number, flaky: { cases: string[]; run: number } = { cases: [], run: -1 }): boolean {
  if (needsCitation(item) && !hasCitationRule(prompt)) return false;
  if (needsDefer(item) && !hasDeferRule(prompt)) return false;
  return !(flaky.cases.includes(item.metadata.caseId) && run === flaky.run);
}
