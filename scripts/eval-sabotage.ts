/**
 * The sabotage run: the release gate on a prompt we broke on purpose, which must come out red.
 *
 * `npm run release:gate -- --sabotage` takes the production prompt, removes the citation rule and
 * every defer rule, saves it as a version under the label `sabotage` (never `production`), and runs
 * the release cases on that version. A gate that stays green on it is blind to the two things the
 * prompt exists to do, so that run also exits non-zero, with its own message.
 */
import { RegressionError } from "@langfuse/client";

export const SABOTAGE_LABEL = "sabotage";

// The line that tells the agent to cite, and the lines that tell it to decline.
const CITATION = /cite each fact as \[doc_id, section\]/;
const DEFER = /^\s*-\s.*\b(NOT_APPROVED_IN_COUNTRY|OFF_LABEL_REFUSAL|INSUFFICIENT_CONTEXT|OUT_OF_SCOPE)\b/;

export type Sabotaged = { prompt: string; droppedCitation: string[]; droppedDefer: string[] };

// Throws when the prompt has no citation line or no defer rule: a sabotage that removed nothing proves nothing.
export function sabotage(prompt: string): Sabotaged {
  const lines = prompt.split("\n");
  const droppedCitation = lines.filter((line) => CITATION.test(line));
  const droppedDefer = lines.filter((line) => DEFER.test(line));
  if (!droppedCitation.length) throw new Error("This prompt has no citation line to remove, so a sabotage of it would prove nothing.");
  if (!droppedDefer.length) throw new Error("This prompt has no defer rule to remove, so a sabotage of it would prove nothing.");
  const gone = new Set([...droppedCitation, ...droppedDefer]);
  return { prompt: lines.filter((line) => !gone.has(line)).join("\n"), droppedCitation, droppedDefer };
}

export const hasCitationRule = (prompt: string) => prompt.split("\n").some((line) => CITATION.test(line));
export const hasDeferRule = (prompt: string) => prompt.split("\n").some((line) => DEFER.test(line));

// The verdict on a sabotage run: red is what a working gate does.
export function sabotageCaught(verdict: () => void): boolean {
  try {
    verdict();
    return false;
  } catch (error) {
    if (error instanceof RegressionError) return true;
    throw error;
  }
}

// The exit code of the --sabotage command: 1 when the gate caught it (red, like any red gate), 3 when it did not.
export const SABOTAGE_EXIT = { caught: 1, missed: 3 } as const;
