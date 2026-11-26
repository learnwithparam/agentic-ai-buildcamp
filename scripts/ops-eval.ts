// npm run ops:measure: what one answer costs the desk in time, money and broken output, on the
// demo questions in scripts/open-questions.ts. Each question is one turn on the real agent, the
// real gateway and the real label index, one after another so the latency is a doctor's wait.
//
// The measures (written to docs/runs/ops.json, compared by docs/measures.md):
//   p95_latency_seconds    the 95th percentile (nearest rank) of a turn's wall time
//   cost_per_question_usd  the mean of the gateway's own cost (usage.cost) over the turns
//   parse_failure_rate     structured-output calls whose JSON did not parse, over all such calls
//
// --fake runs no turn. It feeds fixed turn records to the same summary, so the arithmetic and the
// file shape can be tested offline (scripts/ops-eval.test.ts). Its numbers prove nothing about the
// desk, so it writes docs/runs/ops.fake.json unless --out says otherwise, never docs/runs/ops.json.
import "../src/server/load-env";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureTurn, type StageTiming, type TurnMetrics } from "../src/server/ops/meter";
import { percentile, summarize } from "../src/server/ops/metrics";
import { OPEN_QUESTIONS, type OpenQuestion } from "./open-questions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type OpsRun = {
  measures: { "ops.p95_latency_seconds": number; "ops.cost_per_question_usd": number; "ops.parse_failure_rate": number };
  commit: string;
  at: string;
  questions: number;
  structured_calls: number;
  model_calls: number;
  fake: boolean;
  // Each turn's wall time and the time of each stage in it, so a run shows where the wait goes.
  // A stage nested in another (claim_extract and claim_judge inside claim_check, a search stage
  // inside tool:search_labels) is counted in both, so the totals do not add up to the turn.
  turns: Array<{ ask?: string; seconds: number; calls: number; cost_usd: number; stages: StageTiming[] }>;
  stage_summary: Record<string, { count: number; median_seconds: number; p95_seconds: number; total_seconds: number }>;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

export function summarizeStages(turns: Array<Pick<TurnMetrics, "stages">>): OpsRun["stage_summary"] {
  const by = new Map<string, number[]>();
  for (const turn of turns) for (const { stage, seconds } of turn.stages ?? []) by.set(stage, [...(by.get(stage) ?? []), seconds]);
  return Object.fromEntries(
    [...by.entries()]
      .map(([stage, seconds]) => [stage, { count: seconds.length, median_seconds: round(percentile(seconds, 0.5)), p95_seconds: round(percentile(seconds, 0.95)), total_seconds: round(seconds.reduce((a, b) => a + b, 0)) }] as const)
      .sort((a, b) => b[1].total_seconds - a[1].total_seconds)
  );
}

export function toRun(turns: TurnMetrics[], extra: { commit: string; at: string; fake: boolean; asks?: string[] }): OpsRun {
  // A desk answer always calls the model (the router at least). A turn with no call means the
  // counter was not attached to the client the desk used, and a cost of $0 would be an empty reading.
  const silent = turns.filter((turn) => turn.calls === 0).length;
  if (silent) throw new Error(`${silent} of ${turns.length} turns made no model call. A desk answer always calls the model, so the counter is not seeing the desk's calls and the cost would read $0.`);
  const missing = turns.reduce((sum, turn) => sum + turn.callsWithoutCost, 0);
  if (missing) throw new Error(`${missing} model calls came back with no cost, so the cost per question would be too low. The gateway must return usage.cost.`);
  const measures = summarize(turns);
  return {
    measures: {
      "ops.p95_latency_seconds": measures.p95_latency_seconds,
      "ops.cost_per_question_usd": measures.cost_per_question_usd,
      "ops.parse_failure_rate": measures.parse_failure_rate
    },
    commit: extra.commit,
    at: extra.at,
    fake: extra.fake,
    questions: turns.length,
    structured_calls: turns.reduce((sum, turn) => sum + turn.structuredCalls, 0),
    model_calls: turns.reduce((sum, turn) => sum + turn.calls, 0),
    turns: turns.map((turn, i) => ({ ...(extra.asks?.[i] ? { ask: extra.asks[i] } : {}), seconds: round(turn.seconds), calls: turn.calls, cost_usd: round(turn.costUsd), stages: turn.stages ?? [] })),
    stage_summary: summarizeStages(turns)
  };
}

// Twenty fixed turn records: the first 19 take 1 to 19 seconds and the last 40, one turn holds a
// parse failure out of 40 structured calls, and every turn costs four cents.
export function fixedTurns(): TurnMetrics[] {
  return Array.from({ length: 20 }, (_, i) => ({
    seconds: i === 19 ? 40 : i + 1,
    calls: 4,
    costUsd: 0.04,
    callsWithoutCost: 0,
    structuredCalls: 2,
    parseFailures: i === 3 ? 1 : 0,
    stages: []
  }));
}

async function realTurns(questions: OpenQuestion[]): Promise<TurnMetrics[]> {
  const [{ createPool, migrate }, { env }, { useService }, { connectLabelIndex }, { runMedinfoTurn }, users] = await Promise.all([
    import("../src/server/db"),
    import("../src/server/env"),
    import("../src/server/gateway"),
    import("../src/server/rag/search"),
    import("../src/server/medinfo-agent"),
    import("../src/server/users")
  ]);
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
  useService("eval-runner");
  const pool = createPool(env.databaseUrl);
  try {
    await migrate(pool);
    await connectLabelIndex(pool);
    const turns: TurnMetrics[] = [];
    for (const [index, question] of questions.entries()) {
      const doctor = users.SEED_USERS.find((seed) => seed.email === question.email);
      if (!doctor) throw new Error(`${question.email} is not a seeded doctor.`);
      let metrics: TurnMetrics | undefined;
      const messages = [{ id: `ops-${index}`, type: "human" as const, content: question.ask }];
      await measureTurn(
        () => runMedinfoTurn({ threadId: `ops-${Date.now()}-${index}`, user: users.scriptUser(doctor.tenantId, doctor.country), messages }, () => {}),
        (m) => void (metrics = m)
      );
      turns.push(metrics!);
      console.log(`${String(index + 1).padStart(2)}/${questions.length} ${metrics!.seconds.toFixed(1)}s $${metrics!.costUsd.toFixed(4)} ${question.ask}`);
    }
    return turns;
  } finally {
    await pool.end();
  }
}

export async function measure(options: { fake?: boolean; out?: string; questions?: OpenQuestion[] } = {}): Promise<OpsRun> {
  const fake = options.fake ?? false;
  const questions = options.questions ?? OPEN_QUESTIONS;
  const turns = fake ? fixedTurns() : await realTurns(questions);
  const run = toRun(turns, { asks: fake ? undefined : questions.map((q) => q.ask), commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(), at: new Date().toISOString(), fake });
  const out = options.out ?? path.join(root, "docs/runs", fake ? "ops.fake.json" : "ops.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : undefined;
  const run = await measure({ fake: args.includes("--fake"), out });
  console.log(JSON.stringify(run.measures, null, 2));
  console.log("Stage          count  median  p95   total (seconds, slowest total first)");
  for (const [stage, s] of Object.entries(run.stage_summary)) console.log(`${stage.padEnd(22)} ${String(s.count).padStart(3)} ${s.median_seconds.toFixed(1).padStart(7)} ${s.p95_seconds.toFixed(1).padStart(6)} ${s.total_seconds.toFixed(1).padStart(7)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
