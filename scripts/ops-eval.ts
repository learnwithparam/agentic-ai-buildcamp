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
import { measureTurn, type TurnMetrics } from "../src/server/ops/meter";
import { summarize } from "../src/server/ops/metrics";
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
};

export function toRun(turns: TurnMetrics[], extra: { commit: string; at: string; fake: boolean }): OpsRun {
  const missing = turns.reduce((sum, turn) => sum + turn.callsWithoutCost, 0);
  if (missing) throw new Error(`${missing} model calls came back with no cost, so the cost per question would be too low. The gateway must return usage.cost.`);
  const measures = summarize(turns);
  return {
    measures: {
      "ops.p95_latency_seconds": measures.p95_latency_seconds,
      "ops.cost_per_question_usd": measures.cost_per_question_usd,
      "ops.parse_failure_rate": measures.parse_failure_rate
    },
    ...extra,
    questions: turns.length,
    structured_calls: turns.reduce((sum, turn) => sum + turn.structuredCalls, 0),
    model_calls: turns.reduce((sum, turn) => sum + turn.calls, 0)
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
    parseFailures: i === 3 ? 1 : 0
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
  const turns = fake ? fixedTurns() : await realTurns(options.questions ?? OPEN_QUESTIONS);
  const run = toRun(turns, { commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(), at: new Date().toISOString(), fake });
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
