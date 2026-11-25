import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { FixedControls } from "../src/server/auto/limits";
import { MemorySweepRuns, runSweep } from "../src/server/auto/queue";
import { createSweep } from "../src/server/auto/sweep";
import type { FactChecker } from "../src/server/content/fact-check";
import type { OutreachPlanner } from "../src/server/content/outreach";
import { createMedinfoAgent } from "../src/server/medinfo-agent";
import type { CaseInput } from "./hcp-cases";

// Lesson 17. A sweep case runs the real sweep with two things fixed by the case, both on purpose:
//   - the limits: whether it is paused and its budget, kept in memory instead of the app's table;
//   - the spend so far: the case says what was already spent today, so a budget stop is the same
//     on every run. The app reads that number from Langfuse (src/server/auto/limits.ts).
// Each case gets a fresh agent, so one case's drafts are never read back by another.
export async function runCaseSweep(agents: { factChecker: FactChecker; outreachPlanner: OutreachPlanner }, input: CaseInput, caseId: string) {
  const limits = input.sweep!;
  const sweep = createSweep({
    desk: { agent: createMedinfoAgent(new MemorySaver()), ...agents },
    controls: new FixedControls({ paused: limits.paused, budgetUsd: limits.budgetUsd, changedBy: limits.paused ? "the case" : null, changedAt: null }),
    spend: async () => limits.spentUsd
  });
  const result = await runSweep(sweep, new MemorySweepRuns(), `${caseId}-${randomUUID()}`, {
    tenantId: input.tenantId,
    trigger: "person",
    today: limits.today,
    instruction: limits.instruction
  });
  return result.report;
}
