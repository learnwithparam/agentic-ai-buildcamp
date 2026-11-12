// bun run reference          the reference employee settles the orientation invoices; the board stays on localhost:7702/board
// bun run reference naive    the naive employee pays the same invoices and says done; then the ledger speaks
// bun run reference record   like the first, with a model key, and saves each reply to reference/replay/
// Add --once to exit after the summary instead of keeping the board open.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TRAPS } from "../worlds/freight-audit/world";
import { runNaive } from "./naive";

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "reference";
const once = args.includes("--once");
const WORLD = process.env.WORLD_URL ?? "http://localhost:7700";
const BATCH: string[] = TRAPS.orientation_batch;
const usd = (n: number) => `USD ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

if (!["reference", "naive", "record"].includes(mode)) {
  console.log(`There is no reference mode called "${mode}". Try: bun run reference, bun run reference naive, bun run reference record`);
  process.exit(1);
}
const up = await fetch(`${WORLD}/health`).then((r) => r.ok).catch(() => false);
if (!up) {
  console.log(`The world is not running at ${WORLD}. Start it in another terminal: bun run world freight-audit`);
  process.exit(2);
}
await fetch(`${WORLD}/admin/reset`, { method: "POST" });
console.log(`Reset the ledger at ${WORLD}: ${BATCH.length} invoices to settle (${BATCH.join(", ")}).\n`);

if (mode === "naive") {
  const said = await runNaive(WORLD, BATCH);
  console.log(`Naive employee says: "${said}"\n`);
  const rows = (await (await fetch(`${WORLD}/api/ledger`)).json()) as any[];
  console.log(`The ledger shows (${WORLD}/ledger):`);
  let once = 0, twice = 0, none = 0;
  for (const id of BATCH) {
    const r = rows.find((x) => x.invoice_id === id);
    const n = r.payments.length;
    n === 0 ? none++ : n === 1 ? once++ : twice++;
    const what = n === 0 ? "NOT PAID" : n === 1 ? "paid once" : `PAID ${n} TIMES`;
    console.log(`  ${id}  ${what.padEnd(12)} invoice ${usd(r.total_usd).padStart(13)}   paid ${usd(r.payments.reduce((a: number, p: any) => a + p.amount_usd, 0)).padStart(13)}`);
  }
  console.log(`\n${once} paid once, ${twice} paid twice, ${none} not paid. The naive employee said done for all ${BATCH.length}.`);
  console.log("The reply is a claim. The ledger decides. Next: bun run reference");
  process.exit(0);
}

// The reference employee runs in this process. Its state and traces start fresh each run.
const here = import.meta.dir;
rmSync(join(here, ".state"), { recursive: true, force: true });
rmSync(join(here, "traces"), { recursive: true, force: true });
Object.assign(process.env, { PORT: process.env.PORT ?? "7701", BOARD_PORT: process.env.BOARD_PORT ?? "7702", WORLD_URL: WORLD,
  STATE_DIR: join(here, ".state"), TRACE_DIR: join(here, "traces"), MODEL_MODE: mode === "record" ? "record" : process.env.MODEL_MODE ?? "replay" });
const { startEmployee, NAME } = await import("./src/employee");
const emp = startEmployee();
const base = `http://localhost:${emp.port}`;
for (const id of BATCH)
  await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: `orientation-${id}`, tenant: "kaas-freight", trigger: { kind: "person", by: "ravi" }, input: { invoice_id: id } }) });
console.log(`Sent ${BATCH.length} jobs to ${NAME} (contract 1). Working...`);
const jobs: any[] = [];
const deadline = Date.now() + 60_000;
for (const id of BATCH) {
  let j: any;
  do { j = await (await fetch(`${base}/jobs/orientation-${id}`)).json(); if (j.status === "working") await Bun.sleep(150); } while (j.status === "working" && Date.now() < deadline);
  jobs.push({ id, ...j });
}
const col = (s: string) => (s === "done" ? "Done" : s === "waiting_for_human" || s === "failed" ? "Needs you" : "Refused");
console.log("");
for (const j of jobs) console.log(`  ${col(j.status).padEnd(10)} ${j.id}  ${j.reason}`);
const board = (await (await fetch(`${base}/board`)).json()) as any;
const t = board.tenants[0];
console.log(`\nCost per invoice settled: USD ${t.cost_per_outcome_usd.toFixed(6)} (${t.outcomes} settled, model spend USD ${t.spend_usd.toFixed(6)}).`);
console.log(`Traces: reference/traces/. The board: http://localhost:${process.env.BOARD_PORT}/board`);
if (once) { emp.stop(); process.exit(0); }
console.log("Leave this running while you look at the board. Press Ctrl+C to stop.");
