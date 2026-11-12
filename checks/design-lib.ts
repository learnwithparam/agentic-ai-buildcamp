// Shared helpers for the Design part checks, and the cost calculator.
// bun run cost <path-to-cost.yaml>   prints cost per outcome with the arithmetic shown line by line.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const text = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
export const has = (dir: string, name: string) => existsSync(join(dir, name));
export const toml = (dir: string, name: string) => Bun.TOML.parse(text(dir, name)) as any;
export const yaml = (dir: string, name: string) => Bun.YAML.parse(text(dir, name)) as any;

// A SELECT that reads a table: the shape every metric and must-never check takes.
export const isQuery = (q: unknown) => typeof q === "string" && /^\s*select\b[\s\S]+\bfrom\s+[a-z_][\w.]*/i.test(q);

// Markdown sections: "## Name" -> body text up to the next "## ".
export function sections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of md.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).trim().toLowerCase();
    out[head] = nl < 0 ? "" : chunk.slice(nl + 1).trim();
  }
  return out;
}

// The hire letter lives in the write-the-hire-letter step. A step that cross-checks it reads, in order:
// employee.toml in the same folder, then the hire-letter step's folder of the same kind (problem or solution).
// A wrong/<mistake>/ folder is judged against the sample hire letter.
export function hireFor(dir: string): any {
  if (has(dir, "employee.toml")) return toml(dir, "employee.toml").hire;
  let leaf = basename(dir);
  let stepDir = dirname(dir);
  if (basename(stepDir) === "wrong") { stepDir = dirname(stepDir); leaf = "solution"; }
  const partDir = dirname(stepDir);
  const hireStep = readdirSync(partDir).find((d) => d.endsWith("-write-the-hire-letter"));
  if (!hireStep) return undefined;
  const file = join(partDir, hireStep, leaf, "employee.toml");
  return existsSync(file) ? (Bun.TOML.parse(readFileSync(file, "utf8")) as any).hire : undefined;
}

// A small JSON Schema validator: the subset our schemas use. Returns the problems found, empty when valid.
type Schema = Record<string, any>;
export function validate(schema: Schema, value: unknown, at = "$"): string[] {
  const errs: string[] = [];
  const t = schema.type;
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (t) {
    const ok = t === "integer" ? Number.isInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : t === kind;
    if (!ok) return [`${at} should be ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} should be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength && value.trim().length < schema.minLength) errs.push(`${at} is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} should be at least ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errs.push(`${at} should be above ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errs.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (kind === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errs.push(`${at}.${k} is missing`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k} is not a known key`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errs;
}

export function schemaIn(stepDir: string, name: string): Schema {
  return JSON.parse(readFileSync(join(stepDir, name), "utf8"));
}

// The cost model. Every number comes from the learner's cost.yaml, never from this code.
export type CostLine = { what: string; how: string; value: string };
export function costOf(c: any): { lines: CostLine[]; perOutcome: number } {
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 6 });
  const usd = (x: number) => `USD ${x.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`;
  const runs = c.runs.good_per_outcome + c.runs.failed_per_outcome;
  const calls = runs * c.calls_per_run;
  const tin = calls * c.tokens_per_call.input;
  const tout = calls * c.tokens_per_call.output;
  const cin = (tin / 1_000_000) * c.price.input_usd_per_million;
  const cout = (tout / 1_000_000) * c.price.output_usd_per_million;
  const per = cin + cout;
  return {
    perOutcome: per,
    lines: [
      { what: "runs per outcome", how: `${n(c.runs.good_per_outcome)} good + ${n(c.runs.failed_per_outcome)} failed`, value: n(runs) },
      { what: "calls per outcome", how: `${n(runs)} runs x ${n(c.calls_per_run)} calls`, value: n(calls) },
      { what: "input tokens", how: `${n(calls)} calls x ${n(c.tokens_per_call.input)}`, value: n(tin) },
      { what: "output tokens", how: `${n(calls)} calls x ${n(c.tokens_per_call.output)}`, value: n(tout) },
      { what: "input cost", how: `${n(tin)} / 1,000,000 x USD ${c.price.input_usd_per_million}`, value: usd(cin) },
      { what: "output cost", how: `${n(tout)} / 1,000,000 x USD ${c.price.output_usd_per_million}`, value: usd(cout) },
      { what: "cost per outcome", how: "input cost + output cost", value: usd(per) },
    ],
  };
}
export const within = (a: number, b: number, share: number) => Math.abs(a - b) <= Math.abs(b) * share;

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || !existsSync(path)) {
    console.log("Name your cost file: bun run cost parts/01-design/05-price-the-outcome/problem/cost.yaml");
    process.exit(1);
  }
  let c: any;
  try { c = Bun.YAML.parse(readFileSync(path, "utf8")); } catch (e) {
    console.log(`cost.yaml is not valid YAML: ${(e as Error).message}`);
    process.exit(1);
  }
  const problems = validate(schemaIn(join(import.meta.dir, "..", "parts", "01-design", "05-price-the-outcome"), "cost.schema.json"), c);
  if (problems.length) {
    console.log("cost.yaml does not match the schema yet:");
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  const { lines, perOutcome } = costOf(c);
  console.log(`Cost per outcome for ${c.employee} (${c.outcome})`);
  console.log(`Prices: the ${c.price.role} role on ${c.price.provider}, checked on ${c.price.checked_on}`);
  for (const l of lines) console.log(`  ${l.what.padEnd(18)} = ${l.how.padEnd(36)} = ${l.value}`);
  const said = c.cost_per_outcome_usd;
  const ok = within(said, perOutcome, 0.01);
  console.log(`  ${"your file says".padEnd(18)} = USD ${said}  ${ok ? "(matches within 1%)" : "(does not match: fix cost_per_outcome_usd)"}`);
  const share = (perOutcome / c.value_per_outcome_usd) * 100;
  console.log(`  ${"value of one".padEnd(18)} = USD ${c.value_per_outcome_usd}  (cost is ${share.toFixed(2)}% of the value)`);
  process.exit(ok && perOutcome < c.value_per_outcome_usd ? 0 : 1);
}
