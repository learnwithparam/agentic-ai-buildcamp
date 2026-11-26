/**
 * The two agents scripts/eval-passk.ts measures: the real one, on the model through the gateway,
 * and the scripted one, which calls no model (scripts/eval-scripted.ts).
 */
import type { Evaluation } from "@langfuse/client";
import { env } from "../src/server/env";
import { usePromptVersion } from "../src/server/medinfo-agent";
import { PROMPT_VARIANTS } from "./prompt-variants";
import type { Agent, CaseRun } from "./eval-passk";
import { sabotage, sabotageCaught, SABOTAGE_LABEL } from "./eval-sabotage";
import { scriptedPass } from "./eval-scripted";
import { assertReleasable, RELEASE_CASES, releasePassRate, runReleaseCases } from "./release-gate";
import { failedScores, startExperiment } from "./experiment";
import { judgeRubric, RUBRIC_SCORE } from "./judge/rubric";
import { JUDGED_SLICES, SCORE_NAME } from "./judge/faithfulness";
import { TIERED_SLICES } from "./scoreboard";
import { loadAllCases } from "./hcp-cases";

// The scripted agent fails ROUTING-05 on the third run only, so pass^5 reads lower than pass@1.
export const SCRIPTED_FLAKY = { cases: ["ROUTING-05"], run: 2 };

// The release run's rows as the experiment would score them, for a prompt, with every score the pass rule asks for.
export function scriptedReleaseRows(prompt: string, run = 0) {
  const byId = new Map(loadAllCases().map((item) => [item.metadata.caseId, item]));
  return RELEASE_CASES.map((id) => {
    const item = byId.get(id)!;
    const value = scriptedPass(item, prompt, run, SCRIPTED_FLAKY) ? 1 : 0;
    return {
      item: { metadata: item.metadata, expectedOutput: item.expectedOutput },
      output: "",
      // Every score failedScores asks for on this case: the text checks carry the scripted verdict, the rest are 1.
      evaluations: [
        { name: "behavior_match", value: 1 },
        { name: "label_checks", value },
        ...(item.expectedOutput.rubrics.length ? [{ name: RUBRIC_SCORE, value: 1 }] : []),
        ...(JUDGED_SLICES.includes(item.metadata.slice) ? [{ name: SCORE_NAME, value: 1 }] : []),
        ...(TIERED_SLICES.includes(item.metadata.slice) ? [{ name: "risk_tier", value: 1 }] : [])
      ]
    };
  });
}

export function scriptedAgent(prompt: string = PROMPT_VARIANTS["per-company"]): Agent {
  const items = loadAllCases();
  const byId = new Map(items.map((item) => [item.metadata.caseId, item]));
  const rows = (ids: string[], text: string, run: number) => ids.map((id) => ({ item: byId.get(id)!, passed: scriptedPass(byId.get(id)!, text, run, SCRIPTED_FLAKY) }));
  return {
    name: "scripted (no model)",
    async runCases(ids, run): Promise<CaseRun[]> {
      return rows(ids, prompt, run).map(({ item, passed }) => ({ caseId: item.metadata.caseId, passed }));
    },
    // The same verdict code as the real gate, over scores the scripted agent produced for the broken prompt.
    async sabotageCaught() {
      const broken = sabotage(prompt).prompt;
      const itemResults = scriptedReleaseRows(broken);
      const result = { itemResults, runEvaluations: [] as Evaluation[] };
      result.runEvaluations.push(...[await releasePassRate({ itemResults: itemResults as never })].flat());
      return sabotageCaught(() => assertReleasable(result));
    },
    async judge() {
      return {};
    }
  };
}

export async function realAgent(): Promise<Agent> {
  const experiment = await startExperiment();
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1]! : "production";
  const prompt = await experiment.langfuse.prompt.get(env.langfusePromptName, { label, cacheTtlSeconds: 0 });
  usePromptVersion(prompt.version);
  console.log(`Measuring prompt "${prompt.name}" version ${prompt.version} (label ${label}).`);
  return {
    name: `real model, prompt version ${prompt.version}`,
    async runCases(ids, run) {
      const result = await experiment.run({
        items: experiment.itemsFor(ids),
        name: "Evals pass^k",
        runName: `evals-passk-r${run + 1}-${new Date().toISOString()}`,
        description: `Run ${run + 1} of the demo set on prompt version ${prompt.version}`,
        metadata: { promptName: prompt.name, promptVersion: prompt.version, promptLabel: label }
      });
      // A case the SDK skipped on a provider error is absent here, which the summary counts as a failure.
      return result.itemResults.map((row) => ({ caseId: (row.item as { metadata?: { caseId?: string } }).metadata?.caseId ?? "", passed: failedScores(row).length === 0 }));
    },
    async sabotageCaught() {
      const broken = sabotage(prompt.prompt as string);
      await experiment.langfuse.prompt.create({ name: prompt.name, type: "text", prompt: broken.prompt, labels: [SABOTAGE_LABEL] });
      const bad = await experiment.langfuse.prompt.get(env.langfusePromptName, { label: SABOTAGE_LABEL, cacheTtlSeconds: 0 });
      usePromptVersion(bad.version);
      try {
        const result = await runReleaseCases(experiment, bad, SABOTAGE_LABEL);
        return sabotageCaught(() => assertReleasable(result));
      } finally {
        usePromptVersion(prompt.version);
      }
    },
    async judge(labelling) {
      const out: Record<string, boolean> = {};
      for (const row of labelling.consensus) out[row.id] = (await judgeRubric(row.question, row.criterion, row.answer)).score;
      return out;
    },
    close: () => experiment.close()
  };
}

