// bun run verify <step-name>            check your work on one step, then show progress on every
//                                       step
// bun run verify <step-name> solution   check the sample solution instead
// bun run verify part <part-name>      check every step in one part (a deliverable)
// bun run verify --report               write verify-report.json for cohort grading
// bun run verify --all                  CI: each check fails on its starter and wrong answers,
//                                       and passes on its solution
// Exit codes: 0 pass, 1 fail, 2 the check could not run.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allSteps, findStep, parts, ROOT, type Step } from "./structure";

export type Rule = {
  says: string;
  test: (dir: string) => boolean | Promise<boolean>;
  tryNext: string;
};
type Result = {
  step: string;
  status: "pass" | "fail" | "error";
  passed: number;
  total: number;
  failed: string[];
};

async function rulesFor(step: Step): Promise<Rule[]> {
  return (await import(join(ROOT, "checks", `${step.name}.ts`))).default;
}

// A rule that throws counts as a fail, so a half-written file never crashes the check.
async function passes(rule: Rule, folder: string): Promise<boolean> {
  try {
    return await rule.test(folder);
  } catch {
    return false;
  }
}

// The step's rules, or null when its check file cannot load.
async function loadRules(step: Step, print: boolean): Promise<Rule[] | null> {
  try {
    return await rulesFor(step);
  } catch (error) {
    if (print) {
      const reason = (error as Error).message;
      console.log(`  ERROR  the check for ${step.name} could not load: ${reason}`);
    }
    return null;
  }
}

function printRule(rule: Rule, ok: boolean) {
  if (ok) console.log(`  PASS  ${rule.says}`);
  else console.log(`  FAIL  ${rule.says}\n        Try next: ${rule.tryNext}`);
}

async function runStep(step: Step, folder: string, print = false): Promise<Result> {
  const rules = await loadRules(step, print);
  if (rules === null) return { step: step.name, status: "error", passed: 0, total: 0, failed: [] };
  const failed: string[] = [];
  for (const rule of rules) {
    const ok = await passes(rule, folder);
    if (!ok) failed.push(rule.says);
    if (print) printRule(rule, ok);
  }
  return {
    step: step.name,
    status: failed.length ? "fail" : "pass",
    passed: rules.length - failed.length,
    total: rules.length,
    failed,
  };
}

const learnerWork = (step: Step) => join(step.dir, "problem");

function wrongAnswers(step: Step) {
  const wrongFolder = join(step.dir, "wrong");
  if (!existsSync(wrongFolder)) return [];
  const mistakes = readdirSync(wrongFolder);
  return mistakes.map((mistake) => ({ name: mistake, dir: join(wrongFolder, mistake) }));
}

// The solution must pass; a missing solution means CI cannot prove the check can pass.
async function solutionProblems(step: Step): Promise<string[]> {
  if (!existsSync(join(step.dir, "solution"))) {
    return [`${step.name}: needs solution/ so CI can prove the check can pass`];
  }
  const solution = await runStep(step, join(step.dir, "solution"));
  if (solution.status === "pass") return [];
  return [`${step.name}: the sample solution fails: ${solution.failed.join("; ")}`];
}

async function wrongAnswerProblems(step: Step): Promise<string[]> {
  const wrong = wrongAnswers(step);
  const problems: string[] = [];
  if (wrong.length === 0) {
    problems.push(
      `${step.name}: needs at least one wrong/<mistake>/ answer that the check must reject`,
    );
  }
  for (const answer of wrong) {
    if ((await runStep(step, answer.dir)).status === "pass") {
      problems.push(`${step.name}: wrong answer "${answer.name}" passes the check`);
    }
  }
  return problems;
}

async function checkProblems(step: Step): Promise<string[]> {
  let rules: Rule[] = [];
  try {
    rules = await rulesFor(step);
  } catch (error) {
    return [`${step.name}: the check could not load: ${(error as Error).message}`];
  }
  const problems: string[] = [];
  for (const rule of rules) {
    const tryNextWords = rule.tryNext.trim().split(/\s+/);
    if (tryNextWords.length < 3) {
      problems.push(`${step.name}: rule "${rule.says}" needs a try-next sentence`);
    }
  }
  if ((await runStep(step, learnerWork(step))).status === "pass") {
    problems.push(`${step.name}: the check passes on the starter, so it checks nothing`);
  }
  problems.push(...(await solutionProblems(step)));
  problems.push(...(await wrongAnswerProblems(step)));
  return problems;
}

async function checkEveryCheck(): Promise<never> {
  const problems: string[] = [];
  // The starters and wrong answers fail on purpose, so their fail messages stay quiet.
  for (const step of allSteps()) problems.push(...(await quietly(() => checkProblems(step))));
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length) console.log(`${problems.length} check problem(s).`);
  else console.log("Every check rejects its starter and wrong answers, and passes its solution.");
  process.exit(problems.length ? 1 : 0);
}

async function writeReport(): Promise<never> {
  const results = await quietly(resultsOnEveryStep);
  const report = { version: 1, at: new Date().toISOString(), results };
  writeFileSync(join(ROOT, "verify-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const passing = results.filter((result) => result.status === "pass").length;
  console.log(`Wrote verify-report.json: ${passing} of ${results.length} steps pass.`);
  process.exit(0);
}

async function verifyPart(partName: string | undefined): Promise<never> {
  const part = parts().find((candidate) => candidate.name === partName);
  if (!part) {
    if (partName) console.log(`There is no part called "${partName}". Parts:`);
    else console.log("Name a part. Parts:");
    for (const known of parts()) console.log(`  bun run verify part ${known.name}`);
    process.exit(1);
  }
  console.log(`Part ${part.name}:`);
  const results: Result[] = [];
  for (const step of part.steps) {
    const result = await runStep(step, learnerWork(step));
    results.push(result);
    const status = result.status.toUpperCase().padEnd(5);
    console.log(`  ${status}  ${step.name}  (${result.passed}/${result.total} rules)`);
  }
  const done = results.filter((result) => result.status === "pass").length;
  const score = `${done}/${results.length} steps pass`;
  if (done === results.length) console.log(`Part ${part.name} is done: ${score}.`);
  else console.log(`${score}. Run bun run verify <step-name> on a FAIL line to see why.`);
  if (results.some((result) => result.status === "error")) process.exit(2);
  process.exit(done === results.length ? 0 : 1);
}

// Checks explain their own fails as they run. When a run is not the one you asked about,
// those lines would only confuse, so this keeps them quiet while the work runs.
async function quietly<Answer>(work: () => Promise<Answer>): Promise<Answer> {
  const printLine = console.log;
  console.log = () => {};
  try {
    return await work();
  } finally {
    console.log = printLine;
  }
}

async function resultsOnEveryStep(): Promise<Result[]> {
  const results: Result[] = [];
  for (const step of allSteps()) results.push(await runStep(step, learnerWork(step)));
  return results;
}

// Done is recomputed from the checks every time, never read from a saved flag.
async function printProgress() {
  console.log("Counting your progress on every step. This can take up to a minute.");
  const results = await quietly(resultsOnEveryStep);
  const passing = results.filter((result) => result.status === "pass").length;
  console.log(`Progress: ${passing}/${results.length} steps pass.`);
}

// The step with this name, or the list of steps and exit when there is none.
function stepOrList(stepName: string | undefined): Step {
  const step = stepName && findStep(stepName);
  if (step) return step;
  if (stepName) console.log(`There is no step called "${stepName}". Steps:`);
  else console.log("Name a step. Steps:");
  for (const known of allSteps()) console.log(`  bun run verify ${known.name}`);
  process.exit(1);
}

async function verifyStep(stepName: string | undefined, which: string | undefined) {
  const step = stepOrList(stepName);
  const asSolution = which === "solution";
  const whose = asSolution ? "sample solution" : "your work";
  console.log(`Checking ${step.name} (${whose}):`);
  const folder = asSolution ? join(step.dir, "solution") : learnerWork(step);
  const result = await runStep(step, folder, true);
  if (result.status === "error") process.exit(2);
  if (result.status === "pass") console.log(`Done. All ${result.total} rules pass.`);
  else {
    console.log(
      `${result.passed} of ${result.total} rules pass. Fix the FAIL lines and run it again.`,
    );
  }
  if (!asSolution) await printProgress();
  process.exit(result.status === "pass" ? 0 : 1);
}

const [command, which] = process.argv.slice(2);

if (command === "--all") await checkEveryCheck();
if (command === "--report") await writeReport();
if (command === "part") await verifyPart(which);
await verifyStep(command, which);
