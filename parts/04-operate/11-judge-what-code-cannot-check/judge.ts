// bun parts/04-operate/11-judge-what-code-cannot-check/judge.ts <your-folder>
// Runs your rubric on each draft with the judge model, one yes or no per question, and saves
// the answers to judge-run.json in your folder. The step check scores that saved run.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateText } from "ai";
import { languageModel, models } from "../../../config/models";

type Criterion = { question: string; pass_when: string };
const here = import.meta.dir;
const folder = resolve(process.argv[2] ?? join(here, "problem"));
const drafts: { id: string; draft: string }[] = JSON.parse(
  readFileSync(join(here, "drafts.json"), "utf8"),
);
const rubric = Bun.YAML.parse(readFileSync(join(folder, "judge.yaml"), "utf8")) as {
  criteria?: Criterion[];
};
const criteria = rubric.criteria ?? [];
if (criteria.length === 0) {
  console.error("judge.yaml has no criteria. Try next: write three questions, then run again.");
  process.exit(2);
}

const model = await languageModel("judge");
const answers: Record<string, boolean[]> = {};
for (const draft of drafts) {
  answers[draft.id] = [];
  for (const criterion of criteria) {
    const { text } = await generateText({
      model,
      prompt: [
        "You judge one draft reply to a vendor.",
        `Question: ${criterion.question}`,
        `Say yes when: ${criterion.pass_when}`,
        `Draft: ${draft.draft}`,
        "Answer with one word, yes or no.",
      ].join("\n"),
    });
    const saidYes = text.trim().toLowerCase().startsWith("yes");
    answers[draft.id].push(saidYes);
  }
}

const criteriaText = JSON.stringify(criteria);
const rubricHash = createHash("sha256").update(criteriaText).digest("hex");
const run = { model: models.judge, rubric: rubricHash, answers };
writeFileSync(join(folder, "judge-run.json"), `${JSON.stringify(run, null, 2)}\n`);
console.log(`Saved judge-run.json for ${drafts.length} drafts.`);
console.log(`Now run: bun run verify judge-what-code-cannot-check ${folder}`);
