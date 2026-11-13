// The Operate part's commands. Run from the repo root.
//   bun parts/04-operate/operate.ts traces
//       the trace viewer on localhost:7703 for the 60-run replay set
//   bun parts/04-operate/operate.ts evals <folder>
//       run the evals in <folder>/evals on the replay set
//   bun parts/04-operate/operate.ts gate <folder> [model]
//       run the swap gate in <folder>/gate.toml; model replaces the candidate
//   bun parts/04-operate/operate.ts record-runs
//       write 02-label-the-traces/runs/ again (authors only: the replay set is fixed)
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contract } from "../../checks/lib/contract";
import { type Running, startEmployee } from "../../checks/lib/employee";
import { startWorld, TRAPS } from "../../worlds/freight-audit/world";
import type { Draft } from "./06-run-the-swap-gate/models/write";
import {
  evalsDir,
  find,
  ledgerRows,
  loadEvals,
  loadReplaySet,
  PART,
  printGate,
  type RecordedRun,
  ROOT,
  RUNS,
  readGate,
  readLabels,
  runEval,
  runGate,
  temporaryFolder,
  writeJson,
} from "./operate-lib";
import { viewerPage } from "./viewer-page";

const [command, folderArgument, modelArgument] = process.argv.slice(2);
const folderPath = (argument?: string) => resolve(process.cwd(), argument ?? ".");

// "12 done, 3 waiting, 2 stopped, 1 failed" for a list of runs.
function statusCounts(runs: { status: string }[]): string {
  const countOf = (status: string) => runs.filter((run) => run.status === status).length;
  return (
    `${countOf("done")} done, ${countOf("waiting_for_human")} waiting, ` +
    `${countOf("stopped")} stopped, ${countOf("failed")} failed`
  );
}

function serveTraceViewer() {
  const runs = loadReplaySet();
  const port = Number(process.env.VIEWER_PORT ?? 7703);
  // The spans go last in each run, so the viewer's JSON reads top to bottom.
  const runsJson = JSON.stringify(
    runs.map(({ spans, ...runWithoutSpans }) => ({ ...runWithoutSpans, spans })),
  );
  Bun.serve({
    port,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/runs.json") {
        return new Response(runsJson, { headers: { "content-type": "application/json" } });
      }
      return new Response(viewerPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  console.log(
    `The replay set: ${runs.length} runs of the clerk in production (${statusCounts(runs)}).`,
  );
  console.log(`Trace viewer: http://localhost:${port}. Press Ctrl+C to stop.`);
}

// One row of the evals table, with the columns lined up under the header.
function tableRow(name: string, failsOn: string, labelledFail: string, labelledPass: string) {
  const nameColumn = name.padEnd(32);
  const failsColumn = failsOn.padStart(8);
  const failColumn = labelledFail.padStart(13);
  const passColumn = labelledPass.padStart(13);
  return `  ${nameColumn} ${failsColumn}  ${failColumn}  ${passColumn}`;
}

async function runEvals() {
  const folder = folderPath(folderArgument);
  const evals = await loadEvals(evalsDir(folder));
  if (evals.length === 0) {
    console.log(
      `No evals in ${join(folder, "evals")}. Write one file per failure mode: evals/<mode>.ts.`,
    );
    process.exit(1);
  }
  const runs = loadReplaySet();
  const labelsFile = find(folder, "labels.csv", "label-the-traces");
  const labelOfRun = new Map(
    readLabels(labelsFile).labels.map((label) => [label.run_id, label.label]),
  );
  console.log(tableRow("eval", "fails on", "labelled fail", "labelled pass"));
  for (const oneEval of evals) {
    const failedRuns = runs.filter((run) => !runEval(oneEval, run).pass);
    const labelledAs = (label: string) =>
      failedRuns.filter((run) => labelOfRun.get(run.run_id) === label).length;
    const labelledPass = labelledAs("pass");
    let warning = "";
    if (labelledPass > 0) warning = "   fails a run you labelled pass";
    const row = tableRow(
      oneEval.mode,
      String(failedRuns.length),
      String(labelledAs("fail")),
      String(labelledPass),
    );
    console.log(row + warning);
  }
  process.exit(0);
}

async function runSwapGate() {
  const { config, problems } = readGate(folderPath(folderArgument));
  if (!config || problems.length > 0) {
    console.log("The gate cannot run:");
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(2);
  }
  const candidate = modelArgument ?? config.candidate;
  let acceptance = "";
  if (config.acceptance) acceptance = ", plus the acceptance cases";
  console.log(
    `Swap gate: ${config.current} (current) against ${candidate} (candidate), ` +
      `${config.invoices.length} invoices, ${config.trials} trials each${acceptance}.\n`,
  );
  const report = await runGate(config, candidate);
  printGate(report);
  writeJson(join(config.dir, "gate-report.json"), report);
  process.exit(report.decision === "allow" ? 0 : 1);
}

// The three drafts where the clerk in production slipped. A live model does not answer
// the same way every time, so the replay set keeps them.
const PRODUCTION_SLIPS: Record<string, Draft> = {
  [TRAPS.duplicate.invoice_id]: {
    action: "pay",
    amount_usd: 2675,
    reason_code: null,
    note: "Matches the rate confirmation and the proof of delivery.",
    approved_by: null,
  },
  [TRAPS.detention_unsigned.invoice_id]: {
    action: "dispute",
    amount_usd: 225,
    reason_code: "ABOVE_RATE",
    note: "Detention billed above the rate.",
    approved_by: null,
  },
  [TRAPS.fuel_above_contract.invoice_id]: {
    action: "dispute",
    amount_usd: 140,
    reason_code: "ABOVE_RATE",
    note: "Fuel billed above the rate.",
    approved_by: null,
  },
};

// The invoices whose jobs run while the ledger is down.
const OUTAGE_INVOICES = ["INV-2033", "INV-2034", "INV-2035", "INV-2036"];

type World = ReturnType<typeof startWorld>;
type Approval = { job_id: string; action: string; amount: number; status: string };

// Starts the sample clerk with the mistake the production clerk had:
// it fails when the ledger is down.
async function startProductionClerk(world: World, repliesFolder: string) {
  const employeeFolder = temporaryFolder("employee");
  const startCommand = `bun ${join(PART, "kit-start.ts")} fails-when-the-ledger-is-down`;
  writeFileSync(
    join(employeeFolder, "employee.toml"),
    `[contract]\nversion = "1"\nmode = "http"\nstart = "${startCommand}"\ntraces = "traces"\n`,
  );
  const env: Record<string, string> = {};
  env.MODEL_ROLE = "smart";
  env.REPLAY_DIR = repliesFolder;
  return startEmployee(employeeFolder, world.url, { env });
}

// Runs one nightly-batch job per invoice and records how each one ended.
async function runEveryInvoice(world: World, running: Running): Promise<RecordedRun[]> {
  const employee = contract(running);
  const invoices = world.db
    .query("SELECT invoice_id, tenant FROM invoices ORDER BY invoice_id")
    .all() as { invoice_id: string; tenant: string }[];
  const recorded: RecordedRun[] = [];
  for (const { invoice_id, tenant } of invoices) {
    world.setFaults({ outage: OUTAGE_INVOICES.includes(invoice_id) });
    const jobId = `batch-${invoice_id}`;
    const started = await employee.startJob({
      job_id: jobId,
      tenant,
      trigger: { kind: "schedule", by: "nightly batch" },
      input: { invoice_id },
    });
    const job = await employee.waitJob(jobId);
    recorded.push({
      run_id: started.body.run_id,
      job_id: jobId,
      invoice_id,
      tenant,
      status: job.status,
      reason: job.reason ?? null,
      cost_usd: job.cost_usd ?? null,
      ledger: { payments: [], disputes: [] },
      approvals: [],
    });
  }
  world.setFaults({ outage: false });
  return recorded;
}

// Fills in what the ledger and the approvals list show for each run, once every job has ended.
async function addLedgerAndApprovals(world: World, running: Running, runs: RecordedRun[]) {
  const response = await fetch(`${running.base}/approvals`);
  const approvals = (await response.json()) as Approval[];
  for (const run of runs) {
    run.ledger = ledgerRows(world, run.invoice_id);
    const approvalsForJob = approvals.filter((approval) => approval.job_id === run.job_id);
    run.approvals = approvalsForJob.map((approval) => ({
      action: approval.action,
      amount: approval.amount,
      status: approval.status,
    }));
  }
}

// The replay set: the clerk on the smart role, in production, before it learned to pause
// when the ledger is down.
async function recordRuns() {
  const { writeModel } = await import("./06-run-the-swap-gate/models/write");
  const repliesFolder = temporaryFolder("replies");
  const slipOf = (evidence: { invoice: { invoice_id: string } }) =>
    PRODUCTION_SLIPS[evidence.invoice.invoice_id] ?? null;
  await writeModel(repliesFolder, "smart", slipOf, "the clerk in production");
  const world = startWorld({ port: 0, dbPath: ":memory:", timeoutMs: 100, quiet: true });
  const timesOutTwice = TRAPS.pay_times_out_twice_without_write.invoice_id;
  world.setFaults({ pay_times_out_without_write: { [timesOutTwice]: 3 } });
  const running = await startProductionClerk(world, repliesFolder);
  const runs = await runEveryInvoice(world, running);
  await addLedgerAndApprovals(world, running, runs);
  await running.stop();
  world.stop();
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(join(RUNS, "spans"), { recursive: true });
  for (const run of runs) {
    const spansFile = `${run.run_id}.jsonl`;
    cpSync(join(running.traceDir, spansFile), join(RUNS, "spans", spansFile));
  }
  writeJson(join(RUNS, "runs.json"), runs);
  const runsFolder = RUNS.replace(`${ROOT}/`, "");
  console.log(`Wrote ${runs.length} runs to ${runsFolder}: ${statusCounts(runs)}.`);
}

if (command === "traces") {
  serveTraceViewer();
} else if (command === "evals") {
  await runEvals();
} else if (command === "gate") {
  await runSwapGate();
} else if (command === "record-runs") {
  await recordRuns();
  process.exit(0);
} else {
  console.log(
    "Try: bun parts/04-operate/operate.ts traces | evals <folder> | gate <folder> [model]",
  );
  process.exit(command ? 1 : 0);
}
