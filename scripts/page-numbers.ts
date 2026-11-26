// A number on a page that was measured comes from a run. The page writes the number and, right
// after it, a comment that names where it came from:
//
//   It passed 22<!-- from: docs/runs/scoreboard-07.json#passed --> of 28<!-- from: docs/runs/scoreboard-07.json#total -->.
//
// This check fails when the number differs from the run value (at the digits the page shows, so
// 0.95 matches 0.952), when the file or the path is missing, or when no number sits before the
// comment. A "%" after the number means the run value is a share: 95% matches 0.952.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutFrontMatter } from "./plain-english";

export const FROM = /(-?\d[\d,]*(?:\.\d+)?)(%?)\s*<!--\s*from:\s*(\S+?)#(\S+?)\s*-->/g;
const ANY_FROM = /<!--\s*from:/g;

// Walk a dotted path. A key may hold dots itself ("search.recall_at_5"), so take the longest key that fits.
export function resolvePath(value: unknown, dotted: string): unknown {
  if (dotted === "") return value;
  if (value === null || typeof value !== "object") return undefined;
  const parts = dotted.split(".");
  for (let take = parts.length; take >= 1; take--) {
    const key = parts.slice(0, take).join(".");
    if (!Object.hasOwn(value, key)) continue;
    const found = resolvePath((value as Record<string, unknown>)[key], parts.slice(take).join("."));
    if (found !== undefined) return found;
  }
  return undefined;
}

const decimals = (shown: string) => shown.split(".")[1]?.length ?? 0;
const round = (value: number, places: number) => Math.round((value + Number.EPSILON) * 10 ** places) / 10 ** places;

export function numberProblems(file: string, page: string, read: (path: string) => unknown | null): string[] {
  const problems: string[] = [];
  const text = withoutFrontMatter(page);
  let matched = 0;
  for (const match of text.matchAll(FROM)) {
    matched++;
    const [, shown, percent, runFile, dotted] = match;
    const line = text.slice(0, match.index).split("\n").length;
    const where = `${file}:${line}`;
    const run = read(runFile);
    if (run === null) {
      problems.push(`${where}: ${runFile} does not exist.`);
      continue;
    }
    const value = resolvePath(run, dotted);
    if (typeof value !== "number") {
      problems.push(`${where}: no number at ${runFile}#${dotted}.`);
      continue;
    }
    const places = decimals(shown);
    const shownValue = Number(shown.replace(/,/g, ""));
    const runValue = percent ? value * 100 : value;
    if (round(runValue, places) !== shownValue) {
      problems.push(`${where}: the page says ${shown}${percent}, ${runFile}#${dotted} holds ${percent ? `${round(runValue, places)}%` : value}.`);
    }
  }
  rowProblems(file, text, read, problems);
  const comments = [...text.matchAll(ANY_FROM)].length;
  if (comments > matched) problems.push(`${file}: ${comments - matched} from-comment(s) have no number right before them, or no "file#path". Write 12<!-- from: docs/runs/x.json#path -->.`);
  return problems;
}

// A scoreboard row copied onto a page ends with <!-- from-row: docs/runs/scoreboard-07.json -->. Its
// chapter, its Passed cell and every slice cell (named by the table's header) must equal the run's.
const FROM_ROW = /<!--\s*from-row:\s*(\S+)\s*-->/;
function rowProblems(file: string, text: string, read: (path: string) => unknown | null, problems: string[]): number {
  const lines = text.split("\n");
  const cells = (line: string) => line.replace(FROM_ROW, "").split("|").slice(1, -1).map((cell) => cell.trim());
  let count = 0;
  lines.forEach((line, index) => {
    const found = FROM_ROW.exec(line);
    if (!found) return;
    count++;
    const where = `${file}:${index + 1}`;
    let header = index - 1;
    while (header >= 0 && lines[header].startsWith("|") && !/^\|\s*Chapter\b/.test(lines[header])) header--;
    if (header < 0 || !lines[header].startsWith("|")) return void problems.push(`${where}: from-row needs a table header that starts with Chapter.`);
    const run = read(found[1]) as { chapter?: string; passed?: number; total?: number; slices?: Record<string, { passed: number; total: number }> } | null;
    if (run === null) return void problems.push(`${where}: ${found[1]} does not exist.`);
    const names = cells(lines[header]);
    const values = cells(line);
    const tally = (t?: { passed: number; total: number }) => (t ? `${t.passed}/${t.total}` : "-");
    names.forEach((name, column) => {
      if (name === "Change" || name === "Run" || name === "Reading") return;
      const shown = values[column];
      if (name === "Chapter") {
        if (shown !== run.chapter) problems.push(`${where}: the row says chapter ${shown}, ${found[1]} is chapter ${run.chapter}.`);
        return;
      }
      const held = name === "Passed" ? tally(run as { passed: number; total: number }) : tally(run.slices?.[name]);
      if (shown !== held) problems.push(`${where}: "${name}" says ${shown}, the run holds ${held}.`);
    });
  });
  return count;
}

const readRun = (path: string): unknown | null => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

export function pageFiles(): string[] {
  const learner = readdirSync("docs/learner", { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".md")).map((name) => `docs/learner/${name}`);
  return ["README.md", "docs/walkthrough.md", "docs/one-question.md", ...learner.sort()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = pageFiles();
  const problems = files.flatMap((file) => numberProblems(file, readFileSync(file, "utf8"), readRun));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Every number with a from-comment matches its run (${files.length} pages).`);
}
