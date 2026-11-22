// Runs one agent over a golden set and returns a grade for each case.
import type { GoldenSet } from "../../../src/golden";
import { type AgentResult, type Grade, grade } from "../../../src/grade";

export type Agent = (question: string, persona: string) => Promise<AgentResult>;

export async function runGolden(agent: Agent, set: GoldenSet): Promise<Grade[]> {
  const grades: Grade[] = [];
  for (const golden of set.cases) {
    const result = await agent(golden.question, golden.persona);
    grades.push(grade(golden, result));
  }
  return grades;
}
