// The Operate part's commands. Run from the repo root.
//   bun parts/04-operate/operate.ts traces                 the trace viewer on localhost:7703 for the 60-run replay set
//   bun parts/04-operate/operate.ts evals <folder>         run the evals in <folder>/evals on the replay set
//   bun parts/04-operate/operate.ts gate <folder> [model]  run the swap gate in <folder>/gate.toml; model replaces the candidate
//   bun parts/04-operate/operate.ts record-runs            write runs/ again (authors only: the replay set is fixed)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startWorld, TRAPS } from "../../worlds/freight-audit/world";
import { startEmployee } from "../../checks/lib/employee";
import { contract } from "../../checks/lib/contract";
import { KIT, RUNS, ROOT, evalsDir, find, ledgerRows, loadEvals, loadReplaySet, printGate, readGate, readLabels, runEval, runGate, tmp, usd, writeJson, type RecordedRun } from "./operate-lib";
import { viewerPage } from "./viewer-page";

const [cmd, arg, extra] = process.argv.slice(2);
const folder = (a?: string) => resolve(process.cwd(), a ?? ".");

if (cmd === "traces") {
  const runs = loadReplaySet();
  const port = Number(process.env.VIEWER_PORT ?? 7703);
  const data = JSON.stringify(runs.map(({ spans, ...r }) => ({ ...r, spans })));
  Bun.serve({ port, fetch: (req) => new URL(req.url).pathname === "/runs.json"
    ? new Response(data, { headers: { "content-type": "application/json" } })
    : new Response(viewerPage(), { headers: { "content-type": "text/html; charset=utf-8" } }) });
  const by = (s: string) => runs.filter((r) => r.status === s).length;
  console.log(`The replay set: ${runs.length} runs of the clerk in production (${by("done")} done, ${by("waiting_for_human")} waiting, ${by("stopped")} stopped, ${by("failed")} failed).`);
  console.log(`Trace viewer: http://localhost:${port}. Press Ctrl+C to stop.`);
} else if (cmd === "evals") {
  const dir = folder(arg);
  const ev = await loadEvals(evalsDir(dir));
  if (!ev.length) { console.log(`No evals in ${join(dir, "evals")}. Write one file per failure mode: evals/<mode>.ts.`); process.exit(1); }
  const runs = loadReplaySet();
  const labels = new Map(readLabels(find(dir, "labels.csv", "label-the-traces")).labels.map((l) => [l.run_id, l.label]));
  console.log(`  ${"eval".padEnd(32)} ${"fails on".padStart(8)}  ${"labelled fail".padStart(13)}  ${"labelled pass".padStart(13)}`);
  for (const e of ev) {
    const fails = runs.filter((r) => !runEval(e, r).pass);
    const lf = fails.filter((r) => labels.get(r.run_id) === "fail").length, lp = fails.filter((r) => labels.get(r.run_id) === "pass").length;
    console.log(`  ${e.mode.padEnd(32)} ${String(fails.length).padStart(8)}  ${String(lf).padStart(13)}  ${String(lp).padStart(13)}${lp ? "   fails a run you labelled pass" : ""}`);
  }
} else if (cmd === "gate") {
  const { config, problems } = readGate(folder(arg));
  if (!config || problems.length) { console.log("The gate cannot run:"); for (const p of problems) console.log(`  - ${p}`); process.exit(2); }
  const cand = extra ?? config.candidate;
  console.log(`Swap gate: ${config.current} (current) against ${cand} (candidate), ${config.invoices.length} invoices, ${config.trials} trials each${config.acceptance ? ", plus the acceptance cases" : ""}.\n`);
  const r = await runGate(config, cand);
  printGate(r);
  writeJson(join(config.dir, "gate-report.json"), r);
  process.exit(r.decision === "allow" ? 0 : 1);
} else if (cmd === "record-runs") {
  await recordRuns();
} else {
  console.log("Try: bun parts/04-operate/operate.ts traces | evals <folder> | gate <folder> [model]");
  process.exit(cmd ? 1 : 0);
}

// The replay set: the clerk on the smart role, in production, before it learned to pause when the ledger is down.
// A live model does not answer the same way every time; these runs keep the three drafts where it slipped.
async function recordRuns() {
  const { writeModel } = await import("./models/write");
  const slips: Record<string, any> = {
    [TRAPS.duplicate.invoice_id]: { action: "pay", amount_usd: 2675, reason_code: null, note: "Matches the rate confirmation and the proof of delivery.", approved_by: null },
    [TRAPS.detention_unsigned.invoice_id]: { action: "dispute", amount_usd: 225, reason_code: "ABOVE_RATE", note: "Detention billed above the rate.", approved_by: null },
    [TRAPS.fuel_above_contract.invoice_id]: { action: "dispute", amount_usd: 140, reason_code: "ABOVE_RATE", note: "Fuel billed above the rate.", approved_by: null },
  };
  const replies = tmp("replies");
  await writeModel(replies, "smart", (e) => slips[e.invoice.invoice_id] ?? null, "the clerk in production");
  const OUTAGE = ["INV-2033", "INV-2034", "INV-2035", "INV-2036"];
  const world = startWorld({ port: 0, dbPath: ":memory:", timeoutMs: 100, quiet: true });
  world.setFaults({ pay_times_out_without_write: { [TRAPS.pay_times_out_twice_without_write.invoice_id]: 3 } });
  const empDir = tmp("employee");
  writeFileSync(join(empDir, "employee.toml"), `[contract]\nversion = "1"\nmode = "http"\nstart = "bun ${join(KIT, "start.ts")} fails-when-the-ledger-is-down"\ntraces = "traces"\n`);
  const emp = await startEmployee(empDir, world.url, { env: { MODEL_ROLE: "smart", REPLAY_DIR: replies } });
  const api = contract(emp);
  const ids = (world.db.query("SELECT invoice_id, tenant FROM invoices ORDER BY invoice_id").all() as any[]);
  const out: RecordedRun[] = [];
  for (const { invoice_id, tenant } of ids) {
    world.setFaults({ outage: OUTAGE.includes(invoice_id) });
    const job_id = `batch-${invoice_id}`;
    const a = await api.startJob({ job_id, tenant, trigger: { kind: "schedule", by: "nightly batch" }, input: { invoice_id } });
    const s = await api.waitJob(job_id);
    out.push({ run_id: a.body.run_id, job_id, invoice_id, tenant, status: s.status, reason: s.reason ?? null, cost_usd: s.cost_usd ?? null, ledger: { payments: [], disputes: [] }, approvals: [] });
  }
  world.setFaults({ outage: false });
  const approvals = (await fetch(`${emp.base}/approvals`).then((r) => r.json())) as any[];
  for (const r of out) {
    r.ledger = ledgerRows(world, r.invoice_id);
    r.approvals = approvals.filter((a) => a.job_id === r.job_id).map((a) => ({ action: a.action, amount: a.amount, status: a.status }));
  }
  await emp.stop();
  world.stop();
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(join(RUNS, "spans"), { recursive: true });
  for (const r of out) cpSync(join(emp.traceDir, `${r.run_id}.jsonl`), join(RUNS, "spans", `${r.run_id}.jsonl`));
  writeJson(join(RUNS, "runs.json"), out);
  const by = (s: string) => out.filter((r) => r.status === s).length;
  console.log(`Wrote ${out.length} runs to ${RUNS.replace(ROOT + "/", "")}: ${by("done")} done, ${by("waiting_for_human")} waiting, ${by("stopped")} stopped, ${by("failed")} failed.`);
}
