// Shared by run-the-swap-gate and refuse-a-bad-model: read gate.md and run the learner's gate.toml.
import { existsSync, readFileSync } from "node:fs";
import { sections } from "../../checks/design-lib";
import { find, type GateReport, readGate, runGate } from "./operate-lib";

export const say = (m: string) => {
  console.log(`        ${m}`);
  return false;
};
export const gate = (d: string) => readGate(d);

export function gateMd(d: string): {
  decision: string | null;
  before: number | null;
  after: number | null;
} {
  const f = find(d, "gate.md", "run-the-swap-gate");
  if (!f || !existsSync(f)) return { decision: null, before: null, after: null };
  const s = sections(readFileSync(f, "utf8"));
  const decision = (s["decision"] ?? "").match(/\b(allow|refuse)\b/i)?.[1]?.toLowerCase() ?? null;
  const cost = s["cost per outcome"] ?? "";
  const num = (w: string) => {
    const m = cost.match(new RegExp(`${w}[^\\n]*?USD\\s*([0-9]*\\.?[0-9]+)`, "i"));
    return m ? Number(m[1]) : null;
  };
  return { decision, before: num("before"), after: num("after") };
}

const runs = new Map<string, Promise<GateReport>>();
export function gateRun(d: string, candidate?: string): Promise<GateReport> | null {
  const { config, problems } = readGate(d);
  if (!config || problems.length) return null;
  const key = `${config.dir}:${candidate ?? config.candidate}`;
  if (!runs.has(key)) runs.set(key, runGate(config, candidate));
  return runs.get(key)!;
}
export const near = (a: number | null, b: number | null) =>
  a !== null && b !== null && Math.abs(a - b) <= 0.02 * Math.abs(b) + 1e-9;
