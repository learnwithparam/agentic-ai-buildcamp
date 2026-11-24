/**
 * The faithfulness judge (lesson 09): is every claim in the answer supported by the
 * tool results the agent read before it wrote it?
 *
 * One rubric, two places that run it:
 *   - In Langfuse, as an LLM-as-a-Judge evaluator on the agent's final generation. You paste
 *     FAITHFULNESS_RUBRIC into the evaluator and map {{conversation}} to the generation's input
 *     ($.messages) and {{answer}} to its output (lesson 09, step 2). That is the copy you
 *     calibrate against your own labels.
 *   - In scripts/run-dataset.ts, through judgeFaithfulness(), on the slices in JUDGED_SLICES.
 *     It sends the same rubric to the same model, with the question and the tool results as
 *     the conversation. Langfuse's copy also sees the system prompt, which the rubric says
 *     is not evidence, so the number you measured is the judge the pass uses.
 *
 * A judge joins the pass only after its agreement with a person reaches KAPPA_BAR.
 * npm run judge:calibrate measures that, and scripts/judge/faithfulness.test.ts fails when
 * the stored calibration in data/calibration/faithfulness.json is below the bar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { env } from "../../src/server/env";

export const SCORE_NAME = "faithfulness";

// Decided before the first measurement: 0.6 is "substantial" agreement on the usual scale.
export const KAPPA_BAR = 0.6;

// The slices whose checks cannot see faithfulness: an answer that joins two sections, a footnote,
// and a drafted reply. Every other slice is decided by behavior_match and label_checks alone.
export const JUDGED_SLICES = ["multi-hop", "footnote", "review"];

export const FAITHFULNESS_RUBRIC = `You check one answer from a medical information agent against the tool results it read before answering.

The conversation is the list of messages the agent saw, as JSON. Only the messages with role "tool" are tool results. The system message and the user's words are not evidence: a fact found only there is not supported.

Score true when every claim in the answer is supported by the tool results.
Score false when the answer:
- states a fact the tool results do not contain (a dose, a number, a time, a condition, a rule, a country or a date),
- contradicts the tool results,
- or cites a section for a fact that section does not hold.

An answer that declines, refuses or asks a question scores true, unless it states a fact the tool results do not hold.

These are not faithfulness failures:
- Restating what the user said, such as the patient's details or the medicine they named. Applying a rule about a class of medicines to a medicine the user named from that class is supported.
- Citing an old or superseded result. If a tool result says it, the claim is supported. Whether it was the right source to use is checked elsewhere.
- Saying the tool results do not cover something, when none of them mention it, even with a citation of the section that was searched.
- Saying what happens to the reply next, such as that a medical reviewer approves a draft or that a report goes to the drug safety team. That is how the desk works, not a claim about the medicine.

Conversation:
{{conversation}}

Answer:
{{answer}}`;

export type Verdict = { score: boolean; reasoning: string };

export type Message = { role: string; content?: unknown };

export function renderRubric(conversation: Message[], answer: string) {
  return FAITHFULNESS_RUBRIC.replace("{{conversation}}", JSON.stringify(conversation)).replace("{{answer}}", answer);
}

export async function judgeFaithfulness(conversation: Message[], answer: string): Promise<Verdict> {
  const openai = new OpenAI({ apiKey: env.openaiApiKey });
  const response = await openai.chat.completions.create({
    model: env.openaiModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: 'Return JSON only: {"reasoning": "one short sentence", "score": true or false}.' },
      { role: "user", content: renderRubric(conversation, answer) }
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

// --- Agreement between a person and the judge.

export type Pair = { human: boolean; judge: boolean };

// Rows are the human label, columns the judge.
export function confusion(pairs: Pair[]) {
  const count = (human: boolean, judge: boolean) => pairs.filter((p) => p.human === human && p.judge === judge).length;
  return {
    bothFaithful: count(true, true),
    humanOnly: count(true, false),
    judgeOnly: count(false, true),
    bothUnfaithful: count(false, false)
  };
}

// Cohen's kappa: agreement beyond what two raters would reach by chance with the same rates.
// A judge that gives every answer the same verdict scores 0, however often it happens to agree.
export function cohenKappa(pairs: Pair[]) {
  if (pairs.length === 0) return 0;
  const n = pairs.length;
  const observed = pairs.filter((p) => p.human === p.judge).length / n;
  const humanTrue = pairs.filter((p) => p.human).length / n;
  const judgeTrue = pairs.filter((p) => p.judge).length / n;
  const chance = humanTrue * judgeTrue + (1 - humanTrue) * (1 - judgeTrue);
  return chance === 1 ? 0 : (observed - chance) / (1 - chance);
}

// --- The stored calibration: the labelled answers, the person's label and the judge's verdict.

export type CalibrationItem = Pair & { observationId: string; traceId: string; answerId: string; answer: string };
export type Calibration = { rubric: string; items: CalibrationItem[] };

export const CALIBRATION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../data/calibration/faithfulness.json");

export function readCalibration(file = CALIBRATION_FILE): Calibration {
  return JSON.parse(readFileSync(file, "utf8")) as Calibration;
}

export function calibrationProblems(calibration: Calibration): string[] {
  const problems: string[] = [];
  if (calibration.rubric !== FAITHFULNESS_RUBRIC) {
    problems.push("data/calibration/faithfulness.json was measured with another rubric. Run npm run judge:calibrate -- --save.");
  }
  const kappa = cohenKappa(calibration.items);
  if (kappa < KAPPA_BAR) problems.push(`The faithfulness judge agrees with the labels at kappa ${kappa.toFixed(2)}, below the bar of ${KAPPA_BAR}.`);
  return problems;
}
