/**
 * The rubric judge: does an answer meet a rubric the dataset wrote for its case?
 *
 * Every `llm-rubric` assert in data/hcp/evals/*.yaml goes through here, so none is dropped. The
 * experiment (scripts/experiment.ts) scores `rubric_match` on each case that has one, and
 * failedScores() counts it in the pass. It is a different judge from the faithfulness judge:
 * faithfulness asks whether the answer follows its sources, this asks whether the answer says
 * what the rubric requires.
 *
 * Its agreement with two people is measured on the items in data/calibration/rubric-labels.tsv
 * (scripts/eval-calibration.ts). npm run evals:measure writes that measurement, and
 * calibrationProblems() there lists what is still missing. The measure prints it, so an
 * uncalibrated judge is never silent. The dataset run scores the rubrics either way.
 */
import { observeOpenAI } from "@langfuse/openai";
import { env } from "../../src/server/env";
import { modelClient } from "../../src/server/gateway";

export const RUBRIC_SCORE = "rubric_match";

export const RUBRIC_JUDGE_PROMPT = `You check one answer from a medical information agent against a rubric.

Score true only when the answer does everything the rubric requires and does nothing it forbids.
Score false when a required fact, dose, number, date, citation or decision is missing or wrong, or when the answer does what the rubric forbids.
Judge the meaning, not the exact words. The answer may be longer than the rubric.

Question:
{{question}}

Rubric:
{{rubric}}

Answer:
{{answer}}`;

export type RubricVerdict = { score: boolean; reasoning: string };

export function renderRubricPrompt(question: string, rubric: string, answer: string) {
  return RUBRIC_JUDGE_PROMPT.replace("{{question}}", () => question).replace("{{rubric}}", () => rubric).replace("{{answer}}", () => answer);
}

export async function judgeRubric(question: string, rubric: string, answer: string): Promise<RubricVerdict> {
  const openai = observeOpenAI(modelClient(), { generationName: "rubric-judge" });
  const response = await openai.chat.completions.create({
    model: env.openaiModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: 'Return JSON only: {"reasoning": "one short sentence", "score": true or false}.' },
      { role: "user", content: renderRubricPrompt(question, rubric, answer) }
    ]
  });
  let parsed: { score?: unknown; reasoning?: unknown } = {};
  try {
    parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
  } catch {
    parsed = {};
  }
  return {
    score: parsed.score === true,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "The judge returned no verdict."
  };
}

// A case with several rubrics passes only when every one passes. The comment names each that failed.
export async function judgeRubrics(question: string, rubrics: string[], answer: string): Promise<{ score: boolean; comment: string }> {
  const verdicts = await Promise.all(rubrics.map((rubric) => judgeRubric(question, rubric, answer)));
  return rubricOutcome(rubrics, verdicts);
}

export function rubricOutcome(rubrics: string[], verdicts: RubricVerdict[]): { score: boolean; comment: string } {
  const failed = rubrics.flatMap((rubric, index) => (verdicts[index]?.score ? [] : [`"${rubric}": ${verdicts[index]?.reasoning ?? "no verdict"}`]));
  return { score: failed.length === 0, comment: failed.length === 0 ? `All ${rubrics.length} rubric(s) met.` : `Rubric not met: ${failed.join(" | ")}` };
}
