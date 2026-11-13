// The ledger answers 503 for a while. The employee pauses, shows one incident card on GET /board,
// and resumes every job after, paying each once. runbook.md has Detect, Stop, Tell, Fix and Learn.
// 3 fresh trials.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drill } from "../parts/04-operate/drill";
import { evalsDir, loadEvals } from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const RUNBOOK_SECTIONS = ["detect", "stop", "tell", "fix", "learn"];
const PEOPLE = /\b(Lena|Ravi|finance lead|AP clerk)\b/i;

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

// A rule test that passes when the drill found nothing wrong with this one part of the outage.
function drillShows(part: "pauses" | "oneCard" | "resumes") {
  return async (folder: string) => {
    const result = await drill(folder);
    if (result.error) return say(result.error);
    const problem = result[part];
    if (problem === null) return true;
    return say(problem);
  };
}

function runbookIn(folder: string): Record<string, string> {
  const path = join(folder, "runbook.md");
  if (!existsSync(path)) return {};
  return sections(readFileSync(path, "utf8"));
}

function capitalized(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

function hasEverySection(folder: string): boolean {
  const runbook = runbookIn(folder);
  const missing = RUNBOOK_SECTIONS.find((section) => !(runbook[section] ?? "").trim());
  if (!missing) return true;
  return say(`runbook.md has no ${capitalized(missing)} section, or it is empty.`);
}

async function namesThePersonAndTheEval(folder: string): Promise<boolean> {
  const runbook = runbookIn(folder);
  if (!PEOPLE.test(runbook.tell ?? "")) {
    return say(
      "Tell names nobody. Say who hears first: the finance lead (Lena) or the AP clerk (Ravi).",
    );
  }
  const evals = await loadEvals(evalsDir(folder));
  const evalNames = evals.map((oneEval) => oneEval.mode);
  const learn = runbook.learn ?? "";
  if (evalNames.some((name) => learn.includes(name))) return true;
  const listed = evalNames.join(", ") || "none found";
  return say(
    `Learn names none of your evals (${listed}). Name the eval that catches this next time.`,
  );
}

export default [
  {
    says:
      "while the ledger is down, no job ends and the employee does not call the ledger " +
      "again and again",
    test: drillShows("pauses"),
    tryNext:
      "on a 503 from a tool, pause the job and probe the ledger from one loop " +
      "every few hundred milliseconds; " +
      "do not fail the job and do not retry in a tight loop",
  },
  {
    says: "GET /board shows one open incident card during the outage, closed after",
    test: drillShows("oneCard"),
    tryNext:
      "keep one incident for the outage on the board, list the paused jobs on it, " +
      "and close it when the ledger answers",
  },
  {
    says: "after the outage every paused job resumes and the ledger shows each invoice paid once",
    test: drillShows("resumes"),
    tryNext:
      "resume from the step that was paused with the same Idempotency-Key, " +
      "then check the ledger before you report done",
  },
  {
    says: "runbook.md has Detect, Stop, Tell, Fix and Learn, each with at least one line",
    test: hasEverySection,
    tryNext:
      "write five sections in runbook.md: how you notice, how you stop the damage, who you tell, " +
      "how you fix, what you add so it is caught next time",
  },
  {
    says: "Tell names the person to tell, and Learn names one of your evals",
    test: namesThePersonAndTheEval,
    tryNext:
      "in Tell name Lena or Ravi; in Learn name the eval file, such as failed-on-a-ledger-error",
  },
] satisfies Rule[];
