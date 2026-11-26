/**
 * The measures: every number the desk must reach, each against a bar from a real tool.
 *
 * docs/measures.md holds one table row per measure. A row names its target (">= 0.95", "= 0")
 * and, once a real run has produced it, the measured value and the run file in docs/runs/.
 *
 * - check-repo calls checkMeasures(): a row with a value must match its run file and meet its target.
 * - The release step (sync-checkpoints.sh before the tag push) calls checkMeasures({ release: true }),
 *   which also fails on any row still marked "pending". Nothing ships with an unmeasured row.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MEASURES_FILE = path.join(ROOT, "docs/measures.md");
const HEADER = "| Part | Measure | Bar | Target | Measured | Run |";

export type Row = { part: string; measure: string; target: string; measured: string; run: string };

export function parseRows(text: string): Row[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === HEADER);
  if (start < 0) return [];
  const rows: Row[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.push({ part: cells[0], measure: cells[1], target: cells[3], measured: cells[4], run: cells[5] });
  }
  return rows;
}

const TARGET = /^(>=|<=|=)\s*(\d+(?:\.\d+)?)$/;

export function meets(target: string, value: number): boolean {
  const [, op, raw] = TARGET.exec(target) ?? [];
  const bound = Number(raw);
  if (op === ">=") return value >= bound;
  if (op === "<=") return value <= bound;
  return value === bound;
}

// A run file is the JSON a measure script writes: { "measures": { "<measure>": <number> }, "commit": "...", "at": "..." }.
function runValue(runPath: string, measure: string, root: string): number | undefined {
  const file = path.join(root, runPath);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")).measures?.[measure];
  return typeof value === "number" ? value : undefined;
}

export function checkMeasures(options: { release?: boolean; text?: string; root?: string } = {}): string[] {
  const root = options.root ?? ROOT;
  const text = options.text ?? readFileSync(MEASURES_FILE, "utf8");
  const rows = parseRows(text);
  if (rows.length === 0) return [`docs/measures.md: no table with the header "${HEADER}".`];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const where = `docs/measures.md "${row.measure}"`;
    if (seen.has(row.measure)) problems.push(`${where}: listed twice.`);
    seen.add(row.measure);
    if (!TARGET.test(row.target)) problems.push(`${where}: target "${row.target}" is not ">= n", "<= n" or "= n".`);
    if (row.measured === "pending") {
      if (options.release) problems.push(`${where}: still pending. Run its measure before a release.`);
      continue;
    }
    const value = Number(row.measured);
    if (row.measured === "" || Number.isNaN(value)) {
      problems.push(`${where}: measured "${row.measured}" is not a number or "pending".`);
      continue;
    }
    const link = /\]\(([^)]+)\)/.exec(row.run)?.[1];
    if (!link) {
      problems.push(`${where}: has a value but no run file link.`);
      continue;
    }
    const fromRun = runValue(link, row.measure, root);
    if (fromRun === undefined) problems.push(`${where}: ${link} does not hold a number for this measure.`);
    else if (fromRun !== value) problems.push(`${where}: the page says ${value}, ${link} says ${fromRun}.`);
    if (!meets(row.target, value)) problems.push(`${where}: ${value} misses the target ${row.target}.`);
  }
  return problems;
}

function main() {
  const problems = checkMeasures({ release: process.argv.includes("--release") });
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("measures: every measured row matches its run file and meets its target");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
