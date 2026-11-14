// judge.yaml: a rubric for what code cannot check, and proof that the judge agrees with a person.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { hasFile, readText, readYaml } from "./design-lib";

type Draft = { id: string; human: string; critical: boolean };
type JudgeFile = {
  code_checks_instead?: unknown[];
  criteria?: { question?: unknown; pass_when?: unknown }[];
};
// What judge.ts saves: the judge's yes or no for each question on each draft.
type JudgeRun = { model?: unknown; rubric?: unknown; answers?: Record<string, unknown> };

const STEP = join(import.meta.dir, "..", "parts", "04-operate", "11-judge-what-code-cannot-check");
const drafts: Draft[] = JSON.parse(readFileSync(join(STEP, "drafts.json"), "utf8"));

function judgeIn(folder: string): JudgeFile {
  if (!hasFile(folder, "judge.yaml")) return {};
  return readYaml<JudgeFile>(folder, "judge.yaml") ?? {};
}

function runIn(folder: string): JudgeRun {
  if (!hasFile(folder, "judge-run.json")) return {};
  try {
    return JSON.parse(readText(folder, "judge-run.json")) as JudgeRun;
  } catch {
    return {};
  }
}

const rubricHash = (folder: string) =>
  createHash("sha256")
    .update(JSON.stringify(judgeIn(folder).criteria ?? []))
    .digest("hex");

// A saved run only counts when it was made with this rubric and has a yes or no per question.
function runMatchesRubric(folder: string): boolean {
  const run = runIn(folder);
  const criteria = judgeIn(folder).criteria ?? [];
  if (criteria.length === 0 || String(run.model ?? "").trim() === "") return false;
  if (run.rubric !== rubricHash(folder)) return false;
  return drafts.every((draft) => {
    const given = run.answers?.[draft.id];
    return (
      Array.isArray(given) &&
      given.length === criteria.length &&
      given.every((answer) => typeof answer === "boolean")
    );
  });
}

// The verdict is worked out here from the saved answers: pass only when every question is yes.
function verdictFor(folder: string, draft: Draft): string | undefined {
  if (!runMatchesRubric(folder)) return undefined;
  const given = runIn(folder).answers?.[draft.id] as boolean[];
  return given.every(Boolean) ? "pass" : "fail";
}

function keepsCodeChecksOut(folder: string): boolean {
  const listed = judgeIn(folder).code_checks_instead ?? [];
  return listed.filter((item) => String(item ?? "").trim().length > 8).length >= 2;
}

function hasRubric(folder: string): boolean {
  const criteria = judgeIn(folder).criteria ?? [];
  if (criteria.length < 3) return false;
  return criteria.every(
    (criterion) =>
      String(criterion.question ?? "")
        .trim()
        .endsWith("?") && String(criterion.pass_when ?? "").trim().length > 8,
  );
}

function judgedEveryDraft(folder: string): boolean {
  return runMatchesRubric(folder);
}

function agreement(folder: string): number {
  return drafts.filter((draft) => verdictFor(folder, draft) === draft.human).length;
}

function catchesEveryCriticalDraft(folder: string): boolean {
  const critical = drafts.filter((draft) => draft.critical);
  return critical.every((draft) => verdictFor(folder, draft) === "fail");
}

function failsSomething(folder: string): boolean {
  return drafts.some((draft) => verdictFor(folder, draft) === "fail");
}

export default [
  {
    says: "two things are kept out of the judge because code can check them",
    test: keepsCodeChecksOut,
    tryNext: "list two facts, such as the amount paid, that a ledger query checks better",
  },
  {
    says: "the rubric has three yes or no questions, each with a pass line",
    test: hasRubric,
    tryNext: "write each question so it ends with a question mark, and add a pass_when line",
  },
  {
    says: "judge-run.json is a saved judge run for this rubric, with an answer for every draft",
    test: judgedEveryDraft,
    tryNext: "run judge.ts on your folder again after you change the rubric",
  },
  {
    says: "the judge agrees with the human label on at least eight of ten drafts",
    test: (folder) => agreement(folder) >= 8,
    tryNext: "read each draft it got wrong and tighten the pass_when line for that question",
  },
  {
    says: "the judge fails every draft marked critical",
    test: catchesEveryCriticalDraft,
    tryNext: "add a question that each missed critical draft breaks, then judge again",
  },
  {
    says: "the judge does not say pass to everything",
    test: failsSomething,
    tryNext: "a judge that never fails catches nothing; test it on the bad drafts first",
  },
] satisfies Rule[];
