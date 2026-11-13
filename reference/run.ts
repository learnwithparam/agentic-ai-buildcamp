// bun run reference          the reference employee settles the orientation invoices;
//                            the board stays on localhost:7702/board
// bun run reference naive    the naive employee pays the same invoices and says done;
//                            then the ledger speaks
// bun run reference record   like the first, with a model key, and saves each reply to
//                            reference/replay/
// Add --once to exit after the summary instead of keeping the board open.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TRAPS } from "../worlds/freight-audit/world";
import { runNaive } from "./naive";

type LedgerRow = { invoice_id: string; total_usd: number; payments: { amount_usd: number }[] };
type JobAnswer = { status: string; reason: string };
type BoardRow = { outcomes: number; spend_usd: number; cost_per_outcome_usd: number };

const args = process.argv.slice(2);
const mode = args.find((arg) => !arg.startsWith("--")) ?? "reference";
const once = args.includes("--once");
const WORLD = process.env.WORLD_URL ?? "http://localhost:7700";
const BATCH: string[] = TRAPS.orientation_batch;
const usd = (amount: number) => {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `USD ${amount.toLocaleString("en-US", digits)}`;
};

if (!["reference", "naive", "record"].includes(mode)) {
  console.log(
    `There is no reference mode called "${mode}". ` +
      "Try: bun run reference, bun run reference naive, bun run reference record",
  );
  process.exit(1);
}
const worldIsUp = await fetch(`${WORLD}/health`)
  .then((response) => response.ok)
  .catch(() => false);
if (!worldIsUp) {
  console.log(
    `The world is not running at ${WORLD}. ` +
      "Start it in another terminal: bun run world freight-audit",
  );
  process.exit(2);
}
await fetch(`${WORLD}/admin/reset`, { method: "POST" });
console.log(
  `Reset the ledger at ${WORLD}: ${BATCH.length} invoices to settle (${BATCH.join(", ")}).\n`,
);

function timesPaidLabel(paymentCount: number): string {
  if (paymentCount === 0) return "NOT PAID";
  if (paymentCount === 1) return "paid once";
  return `PAID ${paymentCount} TIMES`;
}

function ledgerLine(invoiceId: string, row: LedgerRow): string {
  const paid = row.payments.reduce((total, payment) => total + payment.amount_usd, 0);
  const label = timesPaidLabel(row.payments.length).padEnd(12);
  const billed = usd(row.total_usd).padStart(13);
  return `  ${invoiceId}  ${label} invoice ${billed}   paid ${usd(paid).padStart(13)}`;
}

async function showNaiveRun() {
  const said = await runNaive(WORLD, BATCH);
  console.log(`Naive employee says: "${said}"\n`);
  const rows = (await (await fetch(`${WORLD}/api/ledger`)).json()) as LedgerRow[];
  console.log(`The ledger shows (${WORLD}/ledger):`);
  const counts = { paidOnce: 0, paidTwice: 0, notPaid: 0 };
  for (const invoiceId of BATCH) {
    const row = rows.find((ledgerRow) => ledgerRow.invoice_id === invoiceId);
    if (!row) throw new Error(`the ledger has no row for ${invoiceId}`);
    const paymentCount = row.payments.length;
    if (paymentCount === 0) counts.notPaid++;
    else if (paymentCount === 1) counts.paidOnce++;
    else counts.paidTwice++;
    console.log(ledgerLine(invoiceId, row));
  }
  console.log(
    `\n${counts.paidOnce} paid once, ${counts.paidTwice} paid twice, ${counts.notPaid} not paid. ` +
      `The naive employee said done for all ${BATCH.length}.`,
  );
  console.log("The reply is a claim. The ledger decides. Next: bun run reference");
}

if (mode === "naive") {
  await showNaiveRun();
  process.exit(0);
}

// The reference employee runs in this process. Its state and traces start fresh each run.
const here = import.meta.dir;
rmSync(join(here, ".state"), { recursive: true, force: true });
rmSync(join(here, "traces"), { recursive: true, force: true });
process.env.PORT = process.env.PORT ?? "7701";
process.env.BOARD_PORT = process.env.BOARD_PORT ?? "7702";
process.env.WORLD_URL = WORLD;
process.env.STATE_DIR = join(here, ".state");
process.env.TRACE_DIR = join(here, "traces");
if (mode === "record") process.env.MODEL_MODE = "record";
const { startEmployee, NAME } = await import("./src/employee");
const employee = startEmployee();
const base = `http://localhost:${employee.port}`;
for (const invoiceId of BATCH)
  await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: `orientation-${invoiceId}`,
      tenant: "kaas-freight",
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: invoiceId },
    }),
  });
console.log(`Sent ${BATCH.length} jobs to ${NAME} (contract 1). Working...`);

async function waitForJob(invoiceId: string, deadline: number): Promise<JobAnswer> {
  let answer: JobAnswer;
  do {
    const response = await fetch(`${base}/jobs/orientation-${invoiceId}`);
    answer = (await response.json()) as JobAnswer;
    if (answer.status === "working") await Bun.sleep(150);
  } while (answer.status === "working" && Date.now() < deadline);
  return answer;
}

const jobs: (JobAnswer & { id: string })[] = [];
const deadline = Date.now() + 60_000;
for (const invoiceId of BATCH)
  jobs.push({ id: invoiceId, ...(await waitForJob(invoiceId, deadline)) });

function columnOf(status: string): string {
  if (status === "done") return "Done";
  if (status === "waiting_for_human" || status === "failed") return "Needs you";
  return "Refused";
}

console.log("");
for (const job of jobs)
  console.log(`  ${columnOf(job.status).padEnd(10)} ${job.id}  ${job.reason}`);
const board = (await (await fetch(`${base}/board`)).json()) as { tenants: BoardRow[] };
const freight = board.tenants[0];
console.log(
  `\nCost per invoice settled: USD ${freight.cost_per_outcome_usd.toFixed(6)} ` +
    `(${freight.outcomes} settled, model spend USD ${freight.spend_usd.toFixed(6)}).`,
);
console.log(
  `Traces: reference/traces/. The board: http://localhost:${process.env.BOARD_PORT}/board`,
);
if (once) {
  employee.stop();
  process.exit(0);
}
console.log("Leave this running while you look at the board. Press Ctrl+C to stop.");
