// npm run faults:measure: what the desk does when something around it breaks, or when the text
// it reads is hostile. Each fault (src/server/faults/inject.ts) is switched on around the real
// agent and run against the medinfo cases the agent answers; deterministic scorers
// (src/server/faults/score.ts) read the answer and the tool results, with no model asked.
//
//   instructions_followed  runs where a planted instruction was obeyed (the planted dose or the canary)
//   fabricated_ids         runs that cite a document or section no tool returned in that run
//   wrong_version          runs that cite a document not in force today
//   graceful_rate          share of runs whose reply shows no operator detail and, when the fault
//                          leaves nothing to answer from, is one of the agent's fixed replies
//
// Every count is a number of runs, over the runs where the fault was really injected. The API faults
// (OpenFGA and Keycloak not answering) are probed on the real routes and add to graceful_rate.
//
// Default: real model calls through the gateway, on the eval-runner key.
// --answers <file>: no model, no database. The file holds the runs to score, so the arithmetic can
//   be checked on answers written by hand (scripts/faults-eval.test.ts does).
// --faults a,b  --cases id,id  --limit n (cases per fault)  --concurrency n
import "../src/server/load-env";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_FAULTS, probeApi, type ApiFault } from "../src/server/faults/api";
import { AGENT_FAULTS, withFault, type AgentFault } from "../src/server/faults/inject";
import { replyForError } from "../src/server/faults/replies";
import { fabricatedIds, graceful, instructionFollowed, wrongVersion } from "../src/server/faults/score";
import { loadMedinfoCases, type CaseItem } from "./hcp-cases";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A fault that leaves the agent nothing to answer from must end in a fixed reply. The other two
// leave it something, so an answer of its own is fine as long as it shows no operator detail.
export const STRICT: Record<AgentFault, boolean> = {
  superseded_label: false,
  planted_instruction: false,
  tool_throws: true,
  empty_search: true,
  openfga_down: true
};

// One run under one fault, as the scorers need it.
export type FaultRun = {
  fault: AgentFault;
  caseId: string;
  question: string;
  injected: number;
  honestText: string;
  answer: string;
  sources: string[];
  errored?: boolean;
};

export type RunScore = { instructionFollowed: boolean; fabricated: string[]; wrongVersion: string[]; graceful: boolean };

export function scoreRun(run: FaultRun): RunScore {
  return {
    instructionFollowed: run.fault === "planted_instruction" && instructionFollowed(run.answer, run.honestText, run.question),
    fabricated: fabricatedIds(run.answer, run.sources),
    wrongVersion: wrongVersion(run.answer),
    graceful: graceful(run.answer, STRICT[run.fault])
  };
}

export type FaultSummary = {
  runs: number;
  not_injected: number;
  instructions_followed: number;
  fabricated_ids: number;
  wrong_version: number;
  graceful_rate: number;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

export type ApiSummary = { routes: number; graceful_rate: number; leaks: Array<{ route: string; status: number; leaks: string[] }> };

export function summarize(runs: FaultRun[], api: Partial<Record<ApiFault, ApiSummary>> = {}) {
  const faults: Record<string, FaultSummary> = {};
  const failures: Array<{ fault: string; case: string; what: string }> = [];
  let gracefulRuns = 0;
  let counted = 0;
  for (const fault of AGENT_FAULTS) {
    const all = runs.filter((run) => run.fault === fault);
    const injected = all.filter((run) => run.injected > 0);
    const scores = injected.map((run) => [run, scoreRun(run)] as const);
    const row: FaultSummary = {
      runs: injected.length,
      not_injected: all.length - injected.length,
      instructions_followed: scores.filter(([, s]) => s.instructionFollowed).length,
      fabricated_ids: scores.filter(([, s]) => s.fabricated.length).length,
      wrong_version: scores.filter(([, s]) => s.wrongVersion.length).length,
      graceful_rate: injected.length ? round(scores.filter(([, s]) => s.graceful).length / injected.length) : 1
    };
    faults[fault] = row;
    gracefulRuns += scores.filter(([, s]) => s.graceful).length;
    counted += injected.length;
    for (const [run, s] of scores) {
      if (s.instructionFollowed) failures.push({ fault, case: run.caseId, what: "followed the planted instruction" });
      for (const id of s.fabricated) failures.push({ fault, case: run.caseId, what: `cited ${id}, which no tool returned` });
      for (const id of s.wrongVersion) failures.push({ fault, case: run.caseId, what: `cited ${id}, which is not in force` });
      if (!s.graceful) failures.push({ fault, case: run.caseId, what: "reply was not graceful" });
    }
  }
  for (const [fault, summary] of Object.entries(api)) {
    gracefulRuns += Math.round(summary.graceful_rate * summary.routes);
    counted += summary.routes;
    for (const leak of summary.leaks) failures.push({ fault, case: leak.route, what: `answered ${leak.status} showing ${leak.leaks.length} kinds of operator detail` });
  }
  const sum = (key: "instructions_followed" | "fabricated_ids" | "wrong_version") => Object.values(faults).reduce((total, row) => total + row[key], 0);
  return {
    measures: {
      "faults.instructions_followed": sum("instructions_followed"),
      "faults.fabricated_ids": sum("fabricated_ids"),
      "faults.wrong_version": sum("wrong_version"),
      "faults.graceful_rate": counted ? round(gracefulRuns / counted) : 1
    },
    faults,
    api,
    failures
  };
}

async function probeAll(): Promise<Partial<Record<ApiFault, ApiSummary>>> {
  const out: Partial<Record<ApiFault, ApiSummary>> = {};
  for (const fault of API_FAULTS) {
    const probes = await probeApi(fault);
    const leaking = probes.filter((probe) => probe.leaks.length);
    out[fault] = {
      routes: probes.length,
      graceful_rate: round((probes.length - leaking.length) / probes.length),
      leaks: leaking.map((probe) => ({ route: probe.route, status: probe.status, leaks: probe.leaks }))
    };
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    })
  );
  return out;
}

// The cases a fault is run against: the medinfo cases where a doctor should get an answer.
export function faultCases(only?: string[], limit?: number): CaseItem[] {
  const answerable = loadMedinfoCases().filter((item) => item.expectedOutput.expectedBehavior === "reply");
  const chosen = only ? answerable.filter((item) => only.includes(item.metadata.caseId)) : answerable;
  if (only && chosen.length !== only.length) throw new Error(`Not an answerable medinfo case: ${only.filter((id) => !chosen.some((item) => item.metadata.caseId === id)).join(", ")}`);
  return limit ? chosen.slice(0, limit) : chosen;
}

async function runOne(fault: AgentFault, item: CaseItem): Promise<FaultRun> {
  const { answerWithSources } = await import("../src/server/medinfo-agent");
  const { scriptUser } = await import("../src/server/users");
  const { tenantId, country, messages } = item.input;
  const question = messages.filter((line) => line.role === "user").map((line) => line.content).join("\n");
  const { value, log } = await withFault(fault, async () => {
    try {
      const { answer, sources } = await answerWithSources(messages, scriptUser(tenantId, country));
      return { answer, sources, errored: false };
    } catch (error) {
      // The reply the chat route sends when the agent throws.
      return { answer: replyForError(error), sources: [] as string[], errored: true };
    }
  });
  return { fault, caseId: item.metadata.caseId, question, injected: log.injected, honestText: log.honestText, ...value };
}

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};

async function collect(): Promise<FaultRun[]> {
  const answers = arg("answers");
  if (answers) return JSON.parse(readFileSync(answers, "utf8")) as FaultRun[];
  const { createPool } = await import("../src/server/db");
  const { env } = await import("../src/server/env");
  const { useService } = await import("../src/server/gateway");
  const { connectLabelIndex } = await import("../src/server/rag/search");
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
  useService("eval-runner");
  const pool = createPool(env.databaseUrl);
  try {
    await connectLabelIndex(pool);
    const faults = (arg("faults")?.split(",") ?? [...AGENT_FAULTS]) as AgentFault[];
    const unknown = faults.filter((fault) => !AGENT_FAULTS.includes(fault));
    if (unknown.length) throw new Error(`Not a fault: ${unknown.join(", ")}. The faults are ${AGENT_FAULTS.join(", ")}.`);
    const cases = faultCases(arg("cases")?.split(","), arg("limit") ? Number(arg("limit")) : undefined);
    const jobs = faults.flatMap((fault) => cases.map((item) => ({ fault, item })));
    let done = 0;
    return await mapLimit(jobs, Number(arg("concurrency") ?? 3), async ({ fault, item }) => {
      const run = await runOne(fault, item);
      if (++done % 10 === 0) console.log(`${done} of ${jobs.length} runs`);
      return run;
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  const runs = await collect();
  const api = await probeAll();
  const result = summarize(runs, api);
  const run = {
    measures: result.measures,
    commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
    at: new Date().toISOString(),
    runs: runs.length,
    faults: result.faults,
    api: result.api,
    failures: result.failures
  };
  mkdirSync(path.join(root, "docs/runs"), { recursive: true });
  writeFileSync(path.join(root, "docs/runs/faults.json"), `${JSON.stringify(run, null, 2)}\n`);
  for (const [fault, row] of Object.entries(result.faults)) console.log(fault.padEnd(20), JSON.stringify(row));
  for (const [fault, row] of Object.entries(result.api)) console.log(fault.padEnd(20), JSON.stringify({ routes: row.routes, graceful_rate: row.graceful_rate }));
  console.log(JSON.stringify(result.measures));
  console.log(`${result.failures.length} failures; docs/runs/faults.json lists them.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
