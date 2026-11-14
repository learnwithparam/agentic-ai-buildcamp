// The capstone: a world pack for the learner's own job. The check reads hire.yaml, cases.yaml and
// evidence.md from the learner's folder, never the course world. It proves shape and evidence.
import type { Rule } from "../scripts/verify";
import { hasFile, isQuery, readText, readYaml, sections } from "./design-lib";

type HireFile = {
  job?: unknown;
  outcome?: unknown;
  metric?: { name?: unknown; query?: unknown };
  must_never?: { rule?: unknown; forbidden_write?: unknown };
};
type CaseRow = { table?: unknown; rows?: unknown };
type PackCase = { kind?: unknown; forbids?: unknown; expect?: CaseRow[] };

// Names that only exist in the course world. A learner's own job never needs them.
const COURSE_WORLD = /freight|\bINV-\d|\bLena\b/i;

function hireIn(folder: string): HireFile {
  if (!hasFile(folder, "hire.yaml")) return {};
  return readYaml<HireFile>(folder, "hire.yaml") ?? {};
}

function casesIn(folder: string): PackCase[] {
  if (!hasFile(folder, "cases.yaml")) return [];
  const listed = readYaml<{ cases?: PackCase[] }>(folder, "cases.yaml")?.cases;
  if (Array.isArray(listed)) return listed;
  return [];
}

const filled = (value: unknown) => String(value ?? "").trim().length > 5;

function evidenceSections(folder: string): Record<string, string> {
  if (!hasFile(folder, "evidence.md")) return {};
  return sections(readText(folder, "evidence.md"));
}

// A run line has a date, such as 2026-11-03, and a trace id or link.
function realRunLines(folder: string): string[] {
  const body = evidenceSections(folder).runs ?? "";
  const allLines = body.split("\n");
  const bullets = allLines.filter((line) => line.trim().startsWith("- "));
  const hasDate = (line: string) => /\d{4}-\d{2}-\d{2}/.test(line);
  const hasTrace = (line: string) => /trace\s+\S+|https:\/\//i.test(line);
  return bullets.filter((line) => hasDate(line) && hasTrace(line));
}

function usdAfter(text: string, word: string): number | null {
  const match = text.match(new RegExp(`${word}[^\\n]*?(?:USD|\\$)\\s*([0-9]*\\.?[0-9]+)`, "i"));
  if (match) return Number(match[1]);
  return null;
}

function costsAreWritten(folder: string): boolean {
  const text = evidenceSections(folder)["before and after"] ?? "";
  const before = usdAfter(text, "before");
  const after = usdAfter(text, "after");
  return before !== null && after !== null && before > 0 && after > 0;
}

function everyFileText(folder: string): string {
  const names = ["hire.yaml", "cases.yaml", "evidence.md"];
  return names
    .filter((name) => hasFile(folder, name))
    .map((name) => readText(folder, name))
    .join("\n");
}

function mustNeverTrapIsZeroRows(folder: string): boolean {
  const forbidden = hireIn(folder).must_never?.forbidden_write;
  if (!filled(forbidden)) return false;
  const traps = casesIn(folder).filter(
    (one) => one.kind === "must-never" && one.forbids === forbidden,
  );
  return (
    traps.length > 0 && traps.every((trap) => (trap.expect ?? []).some((row) => row.rows === 0))
  );
}

export default [
  {
    says: "hire.yaml names the job, the outcome and a must-never rule with the write it forbids",
    test: (folder) => {
      const hire = hireIn(folder);
      return (
        filled(hire.job) &&
        filled(hire.outcome) &&
        filled(hire.must_never?.rule) &&
        filled(hire.must_never?.forbidden_write)
      );
    },
    tryNext: "fill in job, outcome and the must_never rule and forbidden_write in hire.yaml",
  },
  {
    says: "the metric is a named SELECT query",
    test: (folder) => filled(hireIn(folder).metric?.name) && isQuery(hireIn(folder).metric?.query),
    tryNext: "write the metric as a select ... from ... query over your own system of record",
  },
  {
    says: "cases.yaml has five cases that check rows, never the reply",
    test: (folder) => {
      const cases = casesIn(folder);
      const checksRows = (one: PackCase) =>
        Array.isArray(one.expect) && one.expect.length > 0 && one.expect.every((row) => row.table);
      return cases.length >= 5 && cases.every(checksRows);
    },
    tryNext: "give every case an expect list with a table and a rows count; add cases up to five",
  },
  {
    says: "a must-never case forbids the write in your hire letter and expects zero rows",
    test: mustNeverTrapIsZeroRows,
    tryNext: "add a kind: must-never case whose forbids matches forbidden_write, with rows: 0",
  },
  {
    says: "evidence.md holds three real runs, each with a date and a trace",
    test: (folder) => realRunLines(folder).length >= 3,
    tryNext: "add three lines that start with a dash, a date such as 2026-11-03, and a trace id",
  },
  {
    says: "evidence.md has cost per outcome before and after, and one failure fixed",
    test: (folder) =>
      costsAreWritten(folder) &&
      filled(evidenceSections(folder)["one failure fixed"]) &&
      !/^name the failure/i.test(evidenceSections(folder)["one failure fixed"] ?? ""),
    tryNext: "write both USD numbers, and a few sentences on the failure and what you changed",
  },
  {
    says: "nothing comes from the course world",
    test: (folder) =>
      everyFileText(folder).length > 100 && !COURSE_WORLD.test(everyFileText(folder)),
    tryNext: "swap the freight names, such as invoice numbers, for the names in your own job",
  },
] satisfies Rule[];
