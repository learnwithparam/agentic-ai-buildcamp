// Shared helpers for the Design part checks, and the cost calculator.
// bun run cost <path-to-cost.yaml>   prints cost per outcome, with the arithmetic shown line
//                                    by line.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { IDS, PRICES, PRICES_AS_OF } from "../config/models";

export const readText = (folder: string, fileName: string) =>
  readFileSync(join(folder, fileName), "utf8");
export const hasFile = (folder: string, fileName: string) => existsSync(join(folder, fileName));
// The learner writes these files, so the shape is what we hope for; each rule still checks it.
export const readToml = <Shape>(folder: string, fileName: string) =>
  Bun.TOML.parse(readText(folder, fileName)) as Shape;
export const readYaml = <Shape>(folder: string, fileName: string) =>
  Bun.YAML.parse(readText(folder, fileName)) as Shape;

// A SELECT that reads a table: the shape every metric and must-never check takes.
export const isQuery = (query: unknown) =>
  typeof query === "string" && /^\s*select\b[\s\S]+\bfrom\s+[a-z_][\w.]*/i.test(query);

// Markdown sections: "## Name" -> body text up to the next "## ".
export function sections(markdown: string): Record<string, string> {
  const bodyByHeading: Record<string, string> = {};
  for (const chunk of markdown.split(/^## /m).slice(1)) {
    const lineEnd = chunk.indexOf("\n");
    const headingLine = lineEnd < 0 ? chunk : chunk.slice(0, lineEnd);
    const body = lineEnd < 0 ? "" : chunk.slice(lineEnd + 1);
    bodyByHeading[headingLine.trim().toLowerCase()] = body.trim();
  }
  return bodyByHeading;
}

// The [hire] table of employee.toml, as the hire-letter step asks for it.
export type HireLetter = {
  outcome?: unknown;
  metric?: { name?: unknown; query?: unknown };
  must_never?: { rule?: unknown; write?: string; check?: unknown };
  starts_by?: unknown;
  lives?: string;
};
type EmployeeFile = { hire?: HireLetter };

// The hire letter lives in the write-the-hire-letter step. A step that cross-checks it reads, in
// order: employee.toml in the same folder, then the hire-letter step's folder of the same kind
// (problem or solution). A wrong/<mistake>/ folder is judged against the sample hire letter.
export function hireFor(folder: string): HireLetter | undefined {
  if (hasFile(folder, "employee.toml")) return readToml<EmployeeFile>(folder, "employee.toml").hire;
  let kind = basename(folder);
  let stepFolder = dirname(folder);
  if (basename(stepFolder) === "wrong") {
    stepFolder = dirname(stepFolder);
    kind = "solution";
  }
  const partFolder = dirname(stepFolder);
  const hireStep = readdirSync(partFolder).find((name) => name.endsWith("-write-the-hire-letter"));
  if (!hireStep) return undefined;
  const hireFolder = join(partFolder, hireStep, kind);
  if (!hasFile(hireFolder, "employee.toml")) return undefined;
  return readToml<EmployeeFile>(hireFolder, "employee.toml").hire;
}

// The subset of JSON Schema our schemas use.
type Schema = {
  type?: string;
  enum?: unknown[];
  minLength?: number;
  pattern?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  items?: Schema;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
};

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function hasType(type: string, value: unknown): boolean {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return type === kindOf(value);
}

function textProblems(schema: Schema, text: string, path: string): string[] {
  const problems: string[] = [];
  if (schema.minLength && text.trim().length < schema.minLength)
    problems.push(`${path} is too short`);
  if (schema.pattern && !new RegExp(schema.pattern).test(text)) {
    problems.push(`${path} does not match ${schema.pattern}`);
  }
  return problems;
}

function numberProblems(schema: Schema, number: number, path: string): string[] {
  const problems: string[] = [];
  if (schema.minimum !== undefined && number < schema.minimum) {
    problems.push(`${path} should be at least ${schema.minimum}`);
  }
  if (schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum) {
    problems.push(`${path} should be above ${schema.exclusiveMinimum}`);
  }
  return problems;
}

function listProblems(schema: Schema, list: unknown[], path: string): string[] {
  const problems: string[] = [];
  if (schema.minItems && list.length < schema.minItems) {
    problems.push(`${path} needs at least ${schema.minItems} items`);
  }
  const itemSchema = schema.items;
  if (itemSchema) {
    list.forEach((item, i) => {
      problems.push(...validate(itemSchema, item, `${path}[${i}]`));
    });
  }
  return problems;
}

// A key the schema does not list is checked against additionalProperties: false forbids it,
// a schema checks its value, and anything else lets it through.
function keyProblems(schema: Schema, key: string, value: unknown, path: string): string[] {
  const keyPath = `${path}.${key}`;
  const keySchema = schema.properties?.[key];
  if (keySchema) return validate(keySchema, value, keyPath);
  const extraKeys = schema.additionalProperties;
  if (extraKeys === false) return [`${keyPath} is not a known key`];
  if (typeof extraKeys === "object") return validate(extraKeys, value, keyPath);
  return [];
}

function objectProblems(schema: Schema, object: Record<string, unknown>, path: string): string[] {
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in object)) problems.push(`${path}.${key} is missing`);
  }
  for (const [key, value] of Object.entries(object)) {
    problems.push(...keyProblems(schema, key, value, path));
  }
  return problems;
}

// A small JSON Schema validator. Returns the problems found, empty when the value is valid.
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  if (schema.type && !hasType(schema.type, value)) return [`${path} should be ${schema.type}`];
  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path} should be one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") problems.push(...textProblems(schema, value, path));
  if (typeof value === "number") problems.push(...numberProblems(schema, value, path));
  if (Array.isArray(value)) problems.push(...listProblems(schema, value, path));
  if (kindOf(value) === "object") {
    problems.push(...objectProblems(schema, value as Record<string, unknown>, path));
  }
  return problems;
}

export function schemaIn(stepFolder: string, fileName: string): Schema {
  return JSON.parse(readFileSync(join(stepFolder, fileName), "utf8"));
}

// cost.yaml, as cost.schema.json describes it.
export type CostFile = {
  employee: string;
  outcome: string;
  value_per_outcome_usd: number;
  runs: { good_per_outcome: number; failed_per_outcome: number };
  calls_per_run: number;
  tokens_per_call: { input: number; output: number };
  price: {
    role: string;
    provider: string;
    checked_on: string;
    source: string;
    input_usd_per_million: number;
    output_usd_per_million: number;
  };
  cost_per_outcome_usd: number;
};

// The cost model. Every number comes from the learner's cost.yaml, never from this code.
export type CostLine = { what: string; how: string; value: string };

const formatNumber = (number: number) =>
  number.toLocaleString("en-US", { maximumFractionDigits: 6 });

// Six decimals at most, with trailing zeros dropped, but never a bare "USD 1.".
function formatUsd(amount: number): string {
  const trimmed = amount.toFixed(6).replace(/0+$/, "");
  return `USD ${trimmed.replace(/\.$/, ".00")}`;
}

function costSums(cost: CostFile) {
  const runs = cost.runs.good_per_outcome + cost.runs.failed_per_outcome;
  const calls = runs * cost.calls_per_run;
  const inputTokens = calls * cost.tokens_per_call.input;
  const outputTokens = calls * cost.tokens_per_call.output;
  const inputCost = (inputTokens / 1_000_000) * cost.price.input_usd_per_million;
  const outputCost = (outputTokens / 1_000_000) * cost.price.output_usd_per_million;
  return { runs, calls, inputTokens, outputTokens, inputCost, outputCost };
}

export function costOf(cost: CostFile): { lines: CostLine[]; perOutcome: number } {
  const sums = costSums(cost);
  const perOutcome = sums.inputCost + sums.outputCost;
  const good = formatNumber(cost.runs.good_per_outcome);
  const failed = formatNumber(cost.runs.failed_per_outcome);
  const runs = formatNumber(sums.runs);
  const calls = formatNumber(sums.calls);
  const inputTokens = formatNumber(sums.inputTokens);
  const outputTokens = formatNumber(sums.outputTokens);
  const lines: CostLine[] = [
    { what: "runs per outcome", how: `${good} good + ${failed} failed`, value: runs },
    {
      what: "calls per outcome",
      how: `${runs} runs x ${formatNumber(cost.calls_per_run)} calls`,
      value: calls,
    },
    {
      what: "input tokens",
      how: `${calls} calls x ${formatNumber(cost.tokens_per_call.input)}`,
      value: inputTokens,
    },
    {
      what: "output tokens",
      how: `${calls} calls x ${formatNumber(cost.tokens_per_call.output)}`,
      value: outputTokens,
    },
    {
      what: "input cost",
      how: `${inputTokens} / 1,000,000 x USD ${cost.price.input_usd_per_million}`,
      value: formatUsd(sums.inputCost),
    },
    {
      what: "output cost",
      how: `${outputTokens} / 1,000,000 x USD ${cost.price.output_usd_per_million}`,
      value: formatUsd(sums.outputCost),
    },
    { what: "cost per outcome", how: "input cost + output cost", value: formatUsd(perOutcome) },
  ];
  return { perOutcome, lines };
}

export const within = (actual: number, expected: number, share: number) =>
  Math.abs(actual - expected) <= Math.abs(expected) * share;

// Reads the cost file named on the command line, or explains what is wrong and stops.
function readCostFile(path: string | undefined): CostFile {
  if (!path || !existsSync(path)) {
    console.log(
      "Name your cost file: bun run cost parts/01-design/05-price-the-outcome/problem/cost.yaml",
    );
    process.exit(1);
  }
  let cost: CostFile;
  try {
    cost = Bun.YAML.parse(readFileSync(path, "utf8")) as CostFile;
  } catch (error) {
    console.log(`cost.yaml is not valid YAML: ${(error as Error).message}`);
    process.exit(1);
  }
  const stepFolder = join(import.meta.dir, "..", "parts", "01-design", "05-price-the-outcome");
  const problems = validate(schemaIn(stepFolder, "cost.schema.json"), cost);
  if (problems.length) {
    console.log("cost.yaml does not match the schema yet:");
    for (const problem of problems) console.log(`  ${problem}`);
    process.exit(1);
  }
  return cost;
}

// The course's own price for that role, so a learner sees when theirs differs.
// The model behind the role stays unnamed.
function comparePriceWithCourse(price: CostFile["price"]) {
  const idsByProvider: Record<string, Record<string, string> | undefined> = IDS;
  const courseModel = idsByProvider[price.provider]?.[price.role];
  const coursePrice = courseModel ? PRICES[courseModel] : undefined;
  const roleOnProvider = `the ${price.role} role on ${price.provider}`;
  if (courseModel && !coursePrice) {
    console.log(
      `  config/models.ts has no price for ${roleOnProvider}: its cost is unknown there.`,
    );
    return;
  }
  if (!coursePrice) return;
  const sameInput = coursePrice.input === price.input_usd_per_million;
  const sameOutput = coursePrice.output === price.output_usd_per_million;
  if (sameInput && sameOutput) return;
  console.log(
    `  config/models.ts prices ${roleOnProvider} at USD ${coursePrice.input} in, ` +
      `${coursePrice.output} out (read ${PRICES_AS_OF}); your file says ` +
      `${price.input_usd_per_million} in, ${price.output_usd_per_million} out.`,
  );
}

function printCost(cost: CostFile): boolean {
  const { lines, perOutcome } = costOf(cost);
  console.log(`Cost per outcome for ${cost.employee} (${cost.outcome})`);
  const { price } = cost;
  console.log(
    `Prices: the ${price.role} role on ${price.provider}, checked on ${price.checked_on}`,
  );
  comparePriceWithCourse(price);
  for (const line of lines) {
    console.log(`  ${line.what.padEnd(18)} = ${line.how.padEnd(36)} = ${line.value}`);
  }
  const said = cost.cost_per_outcome_usd;
  const matches = within(said, perOutcome, 0.01);
  let verdict = "(does not match: fix cost_per_outcome_usd)";
  if (matches) verdict = "(matches within 1%)";
  console.log(`  ${"your file says".padEnd(18)} = USD ${said}  ${verdict}`);
  const value = cost.value_per_outcome_usd;
  const share = (perOutcome / value) * 100;
  console.log(
    `  ${"value of one".padEnd(18)} = USD ${value}  (cost is ${share.toFixed(2)}% of the value)`,
  );
  return matches && perOutcome < value;
}

if (import.meta.main) {
  const cost = readCostFile(process.argv[2]);
  const worthIt = printCost(cost);
  process.exit(worthIt ? 0 : 1);
}
