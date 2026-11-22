// The grader. One agent result goes in, a pass or a list of reasons comes out.
// The expected facts come from the golden case, which gets them from the catalog.
import type { GoldenCase, Intent } from "./golden";

export type AgentResult = {
  route: Intent; // what the agent decided to do
  text: string; // what the agent said
  citations: string[]; // the readable names of the documents it used
};

export type Grade = { ok: boolean; reasons: string[] };

// Truth keys that must appear in the answer, and truth keys that must never appear.
const MUST_SAY = ["dose", "warning", "driving", "sleepGain", "territory", "plan", "rival", "price"];
const MUST_NOT_SAY = ["staleDose", "draftDose", "staleGuess"];

function plain(text: string): string {
  return text.toLowerCase().replaceAll(",", "");
}

function says(text: string, fact: unknown): boolean {
  return plain(text).includes(plain(String(fact)));
}

function numberReasons(golden: GoldenCase, result: AgentResult): string[] {
  const sales = golden.truth.netSalesUsd;
  if (sales === undefined || says(result.text, sales)) return [];
  return [`the answer should give net sales of ${sales}`];
}

export function grade(golden: GoldenCase, result: AgentResult): Grade {
  const reasons: string[] = [];
  const wanted = String(golden.truth.route ?? golden.intent);
  if (result.route !== wanted) reasons.push(`the route was ${result.route}, wanted ${wanted}`);
  for (const key of MUST_SAY) {
    const fact = golden.truth[key];
    if (fact !== undefined && !says(result.text, fact))
      reasons.push(`the answer lacks ${key}: ${fact}`);
  }
  for (const key of MUST_NOT_SAY) {
    const fact = golden.truth[key];
    if (fact !== undefined && says(result.text, fact))
      reasons.push(`the answer holds old ${key}: ${fact}`);
  }
  reasons.push(...numberReasons(golden, result));
  return { ok: reasons.length === 0, reasons };
}

export function score(grades: Grade[]): string {
  const passed = grades.filter((item) => item.ok).length;
  return `${passed}/${grades.length}`;
}
