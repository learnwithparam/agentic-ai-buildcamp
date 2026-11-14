// What the Operate checks and `bun parts/04-operate/operate.ts` share: the replay set of 60 runs,
// labels, failure modes, evals, fresh runs on a chosen model, and the swap gate.
// Everything here reads the ledger, the world's logs and the traces. Nothing reads a model's reply.
import type { SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contract } from "../../checks/lib/contract";
import { type Running, startEmployee } from "../../checks/lib/employee";
import { type Span, spendFromSpans } from "../../checks/lib/traces";
import { checkerWorld, TRAPS, truth, type World } from "../../checks/lib/world";
import { ROLES } from "../../config/models";
import { pdfText, SEED } from "../../worlds/freight-audit/world";

export const PART = import.meta.dir;
export const ROOT = resolve(PART, "..", "..");
// The sample clerk, started from its employee.toml.
export const KIT = join(PART, "01-show-cost-per-outcome", "solution");
export const RUNS = join(PART, "02-label-the-traces", "runs");
export const MODELS = join(PART, "06-run-the-swap-gate", "models");
export const usd = (amount: number) => `USD ${amount.toFixed(6)}`;

// Two money amounts are the same when they are less than one cent apart.
const ONE_CENT = 0.01;
const sameAmount = (first: number, second: number) => Math.abs(first - second) < ONE_CENT;

// ---------- The world's evidence for one invoice, in the shape an eval reads ----------
type InvoiceLine = { kind: string; amount_usd: number; hours?: number };
type InvoiceEvidence = {
  invoice_id: string;
  load_id: string;
  carrier_id: string;
  received_at: string;
  total_usd: number;
  lines: InvoiceLine[];
  scan_text: string;
};
type OtherInvoice = { invoice_id: string; received_at: string; total_usd: number };
type RateEvidence = {
  linehaul_usd: number;
  fuel_surcharge_cap_usd: number;
  detention_usd_per_hour: number;
  detention_needs_signed_delay: boolean;
};
type DeliveryEvidence = { delivered_at: string; signed_by: string; signed_delay_hours: number };
type Payment = { amount_usd: number; approved_by: string | null };
type Dispute = { reason_code: string; amount_usd: number; approved_by: string | null };
type LedgerRows = { payments: Payment[]; disputes: Dispute[] };
type ApprovalSummary = { action: string; amount: number; status: string };

export type Run = {
  run_id: string;
  job_id: string;
  invoice_id: string;
  tenant: string;
  status: string;
  reason: string | null;
  cost_usd: number | null;
  invoice: InvoiceEvidence;
  other_invoices_on_load: OtherInvoice[];
  rate: RateEvidence;
  proof_of_delivery: DeliveryEvidence;
  ledger: LedgerRows;
  approvals: ApprovalSummary[];
  spans: Span[];
};

// Rows as the world's tables store them.
type InvoiceRow = Omit<InvoiceEvidence, "lines" | "scan_text"> & { lines: string; scan: string };
type RateRow = Omit<RateEvidence, "detention_needs_signed_delay"> & {
  detention_needs_signed_delay: number;
};

// One world, started the first time it is needed, answers every question about the seed data.
let seedWorld: World | null = null;
function seededWorld(): World {
  seedWorld ??= checkerWorld();
  return seedWorld;
}
process.on("exit", () => seedWorld?.stop());

function oneRow<Row>(sql: string, ...bindings: SQLQueryBindings[]): Row {
  return seededWorld()
    .db.query(sql)
    .get(...bindings) as Row;
}

const OTHER_INVOICES_ON_LOAD =
  "SELECT invoice_id, received_at, total_usd FROM invoices WHERE load_id = ? " +
  "AND invoice_id != ? ORDER BY received_at";

function invoiceEvidence(row: InvoiceRow): InvoiceEvidence {
  return {
    invoice_id: row.invoice_id,
    load_id: row.load_id,
    carrier_id: row.carrier_id,
    received_at: row.received_at,
    total_usd: row.total_usd,
    lines: JSON.parse(row.lines),
    scan_text: pdfText(join(SEED, row.scan)),
  };
}

function rateEvidence(row: RateRow): RateEvidence {
  return {
    linehaul_usd: row.linehaul_usd,
    fuel_surcharge_cap_usd: row.fuel_surcharge_cap_usd,
    detention_usd_per_hour: row.detention_usd_per_hour,
    detention_needs_signed_delay: Boolean(row.detention_needs_signed_delay),
  };
}

function deliveryEvidence(row: DeliveryEvidence): DeliveryEvidence {
  return {
    delivered_at: row.delivered_at,
    signed_by: row.signed_by,
    signed_delay_hours: row.signed_delay_hours,
  };
}

export function evidence(invoiceId: string) {
  const invoice = oneRow<InvoiceRow>("SELECT * FROM invoices WHERE invoice_id = ?", invoiceId);
  const loadId = invoice.load_id;
  const rate = oneRow<RateRow>("SELECT * FROM rate_confirmations WHERE load_id = ?", loadId);
  const delivery = oneRow<DeliveryEvidence>(
    "SELECT * FROM proofs_of_delivery WHERE load_id = ?",
    loadId,
  );
  const otherInvoicesQuery = seededWorld().db.query(OTHER_INVOICES_ON_LOAD);
  const otherInvoices = otherInvoicesQuery.all(loadId, invoiceId) as OtherInvoice[];
  return {
    invoice: invoiceEvidence(invoice),
    other_invoices_on_load: otherInvoices,
    rate: rateEvidence(rate),
    proof_of_delivery: deliveryEvidence(delivery),
  };
}

export function tenantOf(invoiceId: string): string {
  const row = oneRow<{ tenant: string } | null>(
    "SELECT tenant FROM invoices WHERE invoice_id = ?",
    invoiceId,
  );
  return row?.tenant ?? "kaas-freight";
}

export const truthOf = (invoiceId: string) => truth(seededWorld(), invoiceId);
type Expected = ReturnType<typeof truth>;

// The ledger holds exactly what the evidence asks for: one payment of the right amount,
// or a dispute with the right reason code.
function ledgerMatches(expected: Expected, ledger: LedgerRows): boolean {
  const { payments, disputes } = ledger;
  if (expected.action === "pay") {
    const paidOnce = payments.length === 1 && disputes.length === 0;
    return paidOnce && sameAmount(payments[0].amount_usd, expected.amount_usd);
  }
  const disputed = payments.length === 0 && disputes.length >= 1;
  return disputed && disputes[0].reason_code === expected.reason_code;
}

// A run that waits for a person is right when the approval it waits on is the right one.
function waitsForTheRightApproval(run: Run, expected: Expected): boolean {
  const waiting = run.approvals.find((approval) => approval.status === "waiting");
  if (!waiting) return false;
  const rightAction = expected.action === "pay" ? "pay_invoice" : "open_dispute";
  return sameAmount(waiting.amount, expected.amount_usd) && waiting.action === rightAction;
}

// Was this run right? The ledger agrees with the evidence, or the employee rightly waits for a
// person, or it rightly refused the white-text scan. Everything else is a fail, whatever the
// employee said.
export function rightOutcome(run: Run): boolean {
  const expected = truthOf(run.invoice_id);
  const { payments, disputes } = run.ledger;
  if (ledgerMatches(expected, run.ledger)) return true;
  if (run.invoice_id === TRAPS.white_text.invoice_id) {
    return payments.length === 0 && run.status === "stopped";
  }
  const ledgerIsEmpty = payments.length === 0 && disputes.length === 0;
  if (run.status === "waiting_for_human" && ledgerIsEmpty) {
    return waitsForTheRightApproval(run, expected);
  }
  return false;
}

// ---------- The replay set: 60 runs of the clerk in production, recorded once ----------
// (operate.ts record-runs writes it.)
export type RecordedRun = Omit<
  Run,
  "invoice" | "other_invoices_on_load" | "rate" | "proof_of_delivery" | "spans"
>;

// A trace file holds one span as JSON on each line.
function parseSpans(text: string): Span[] {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.map((line) => JSON.parse(line));
}

function replayedRun(recorded: RecordedRun): Run {
  const spansFile = join(RUNS, "spans", `${recorded.run_id}.jsonl`);
  const spans = parseSpans(readFileSync(spansFile, "utf8"));
  return { ...recorded, ...evidence(recorded.invoice_id), spans };
}

let replaySet: Run[] | null = null;
export function loadReplaySet(): Run[] {
  if (replaySet) return replaySet;
  const indexText = readFileSync(join(RUNS, "runs.json"), "utf8");
  const recordedRuns = JSON.parse(indexText) as RecordedRun[];
  replaySet = recordedRuns.map(replayedRun);
  return replaySet;
}

export function replayRun(runId: string): Run | undefined {
  return loadReplaySet().find((run) => run.run_id === runId);
}

// ---------- Files a learner writes, found across steps ----------
// A step that builds on an earlier one reads the file in its own folder first, then the earlier
// step's folder of the same kind (problem or solution). A wrong/<mistake>/ folder is judged
// against the sample solution's files, and so is a copy in employee/, which is neither.
export function find(folder: string, file: string, stepSuffix: string): string | null {
  if (existsSync(join(folder, file))) return join(folder, file);
  const isWrongAnswer = basename(dirname(folder)) === "wrong";
  const kind = !isWrongAnswer && basename(folder) === "problem" ? "problem" : "solution";
  const step = readdirSync(PART).find((name) => name.endsWith(`-${stepSuffix}`));
  if (!step) return null;
  const path = join(PART, step, kind, file);
  return existsSync(path) ? path : null;
}

// "" inside a quoted cell stands for one quote character.
const isDoubledQuote = (line: string, i: number) => line[i] === '"' && line[i + 1] === '"';

// One CSV line into its cells. A quoted cell may hold commas.
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let insideQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (insideQuotes && isDoubledQuote(line, i)) {
      current += '"';
      i++;
    } else if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === "," && !insideQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

// Every row of a CSV file, skipping blank lines and # comments.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    rows.push(parseCsvLine(line));
  }
  return rows;
}

export type Label = { run_id: string; label: string; note: string };
export function readLabels(path: string | null): { header: string[]; labels: Label[] } {
  if (!path) return { header: [], labels: [] };
  const [firstRow = [], ...rows] = parseCsv(readFileSync(path, "utf8"));
  const header = firstRow.map((name) => name.toLowerCase());
  const cellIn = (row: string[], column: string) => row[header.indexOf(column)];
  const labels = rows.map((row) => ({
    run_id: cellIn(row, "run_id") ?? "",
    label: (cellIn(row, "label") ?? "").toLowerCase(),
    note: cellIn(row, "note") ?? "",
  }));
  return { header, labels };
}

export type Mode = { mode: string; count: number; runs: string[] };

// The cells of one Markdown table row: "| a | b |" becomes ["a", "b"].
function tableCells(line: string): string[] {
  const withoutOuterBars = line.trim().replace(/^\||\|$/g, "");
  return withoutOuterBars.split("|").map((cell) => cell.trim());
}

function isModeHeader(line: string): boolean {
  const names = tableCells(line).map((cell) => cell.toLowerCase());
  return names.includes("mode") && names.includes("count") && names.includes("runs");
}

// The |---|---| line under a table's header.
const isDividerRow = (line: string) => /^\|?\s*:?-{2,}/.test(line.trim());

function modeFromCells(cells: string[], columns: string[]): Mode {
  const cellUnder = (column: string) => cells[columns.indexOf(column)];
  return {
    mode: cellUnder("mode").replace(/`/g, ""),
    count: Number(cellUnder("count")),
    runs: cellUnder("runs").match(/run-[0-9a-f]{8}/g) ?? [],
  };
}

// The first Markdown table with Mode, Count and Runs columns.
// A row whose mode is still a <placeholder> is not a mode yet.
export function readModes(path: string | null): Mode[] {
  if (!path) return [];
  const allLines = readFileSync(path, "utf8").split("\n");
  const tableLines = allLines.filter((line) => line.trim().startsWith("|"));
  const headerIndex = tableLines.findIndex(isModeHeader);
  if (headerIndex < 0) return [];
  const columns = tableCells(tableLines[headerIndex]).map((cell) => cell.toLowerCase());
  const rowLines = tableLines.slice(headerIndex + 1).filter((line) => !isDividerRow(line));
  const modes = rowLines.map((line) => modeFromCells(tableCells(line), columns));
  return modes.filter((entry) => entry.mode && !/^<.*>$/.test(entry.mode));
}

// ---------- Evals: evals/<mode>.ts ----------
// Each file's default function returns null for a pass, or why the run fails.
export type Eval = { mode: string; file: string; check: (run: Run) => string | null };
type EvalModule = { default?: unknown };

// A file that does not load still becomes an eval: one that fails every run and says why.
function evalThatDoesNotLoad(error: unknown) {
  return () => {
    throw new Error(`the file does not load: ${(error as Error).message}`);
  };
}

async function importEval(file: string): Promise<EvalModule> {
  try {
    return await import(file);
  } catch (error) {
    return { default: evalThatDoesNotLoad(error) };
  }
}

// Files that start with _ are examples, not evals.
const isEvalFile = (name: string) => name.endsWith(".ts") && !name.startsWith("_");

export async function loadEvals(folder: string | null): Promise<Eval[]> {
  if (!folder || !existsSync(folder)) return [];
  const fileNames = readdirSync(folder).filter(isEvalFile);
  const evals: Eval[] = [];
  for (const fileName of fileNames.sort()) {
    const file = resolve(folder, fileName);
    const loaded = await importEval(file);
    if (typeof loaded.default !== "function") continue;
    const check = loaded.default as Eval["check"];
    evals.push({ mode: fileName.replace(/\.ts$/, ""), file, check });
  }
  return evals;
}

type EvalResult = { pass: boolean; why: string | null; error?: string };
export function runEval(evalToRun: Eval, run: Run): EvalResult {
  try {
    const why = evalToRun.check(run);
    return { pass: why === null || why === undefined, why: why ?? null };
  } catch (error) {
    return { pass: false, why: null, error: (error as Error).message };
  }
}

export function evalsDir(folder: string): string | null {
  const own = join(folder, "evals");
  if (existsSync(own)) return own;
  return find(folder, "evals", "write-an-eval-per-failure");
}

// ---------- Recorded models ----------
// models/<name>/model.toml names a role and the recorded replies that stand in for it.
export type Model = { name: string; role: string; replayDir: string };
type ModelToml = { role: string; replies: string };

export function model(name: string): Model | null {
  const file = join(MODELS, name, "model.toml");
  if (!existsSync(file)) return null;
  const settings = Bun.TOML.parse(readFileSync(file, "utf8")) as ModelToml;
  if (!(ROLES as readonly string[]).includes(settings.role)) return null;
  return { name, role: settings.role, replayDir: resolve(dirname(file), settings.replies) };
}

export function modelNames(): string[] {
  const hasModelToml = (name: string) => existsSync(join(MODELS, name, "model.toml"));
  return readdirSync(MODELS).filter(hasModelToml);
}

// ---------- Fresh runs: a new world and a new employee on one model ----------
// The gate plays Lena, the person who approves payments.
export type Fresh = {
  runs: Run[];
  spend: number;
  unknownModels: string[];
  outcomes: number;
  mustNever: string[];
};
type Api = ReturnType<typeof contract>;
type StartedJob = { job_id: string; run_id: string; invoice_id: string };
type FreshOptions = { approveAs?: string | null; tenantOf?: (id: string) => string };
type EmployeeApproval = {
  approval_id: string;
  job_id: string;
  action: string;
  amount: number | string;
  status?: string;
};
type RunSources = { api: Api; world: World; traceDir: string; approvals: EmployeeApproval[] };

// Five random letters and digits, so job ids from two runs never clash.
const shortRandomTag = () => Math.random().toString(36).slice(2, 7);

// The employee reads which recorded model to use from these two environment variables.
const modelEnvironment = (chosenModel: Model): Record<string, string> =>
  Object.fromEntries([
    ["MODEL_ROLE", chosenModel.role],
    ["REPLAY_DIR", chosenModel.replayDir],
  ]);

async function waitingApprovals(api: Api): Promise<EmployeeApproval[]> {
  const answer = await api.approvals("waiting");
  return answer.body ?? [];
}

async function startJobs(
  api: Api,
  invoices: string[],
  options: FreshOptions,
): Promise<StartedJob[]> {
  const tag = shortRandomTag();
  const jobs: StartedJob[] = [];
  for (const invoiceId of invoices) {
    const jobId = `gate-${tag}-${invoiceId}`;
    const tenant = options.tenantOf?.(invoiceId) ?? tenantOf(invoiceId);
    const answer = await api.startJob({
      job_id: jobId,
      tenant,
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: invoiceId },
    });
    jobs.push({ job_id: jobId, run_id: String(answer.body?.run_id ?? ""), invoice_id: invoiceId });
  }
  return jobs;
}

// Approve every approval our own jobs wait on, then wait for those jobs to finish.
async function approveAsPerson(api: Api, jobs: StartedJob[], approver: string): Promise<void> {
  const waiting = await waitingApprovals(api);
  for (const approval of waiting) {
    const isOurJob = jobs.some((job) => job.job_id === approval.job_id);
    if (isOurJob) await api.decide(approval.approval_id, "approve", approver);
  }
  const isNotWorking = (state: { status: string }) => state.status !== "working";
  for (const job of jobs) await api.waitJob(job.job_id, { until: isNotWorking });
}

async function allApprovals(base: string): Promise<EmployeeApproval[]> {
  try {
    const response = await fetch(`${base}/approvals`);
    return await response.json();
  } catch {
    return [];
  }
}

function approvalSummary(approval: EmployeeApproval): ApprovalSummary {
  return {
    action: approval.action,
    amount: Number(approval.amount),
    status: approval.status ?? "waiting",
  };
}

function readTrace(traceDir: string, runId: string): Span[] {
  const traceFile = join(traceDir, `${runId}.jsonl`);
  if (!existsSync(traceFile)) return [];
  return parseSpans(readFileSync(traceFile, "utf8"));
}

async function collectRun(job: StartedJob, sources: RunSources): Promise<Run> {
  const state = (await sources.api.readJob(job.job_id)).body ?? {};
  const ourApprovals = sources.approvals.filter((approval) => approval.job_id === job.job_id);
  return {
    run_id: job.run_id,
    job_id: job.job_id,
    invoice_id: job.invoice_id,
    tenant: tenantOf(job.invoice_id),
    status: String(state.status ?? "unknown"),
    reason: state.reason ?? null,
    cost_usd: state.cost_usd ?? null,
    ...evidence(job.invoice_id),
    ledger: ledgerRows(sources.world, job.invoice_id),
    approvals: ourApprovals.map(approvalSummary),
    spans: readTrace(sources.traceDir, job.run_id),
  };
}

export async function freshRuns(
  employeeDir: string,
  chosenModel: Model,
  invoices: string[],
  options: FreshOptions = {},
): Promise<Fresh> {
  const world = checkerWorld();
  let employee: Running | null = null;
  try {
    const env = modelEnvironment(chosenModel);
    employee = await startEmployee(employeeDir, world.url, { env });
    const api = contract(employee);
    const jobs = await startJobs(api, invoices, options);
    for (const job of jobs) await api.waitJob(job.job_id);
    if (options.approveAs !== null) await approveAsPerson(api, jobs, options.approveAs ?? "lena");
    const approvals = await allApprovals(employee.base);
    const sources: RunSources = { api, world, traceDir: employee.traceDir, approvals };
    const runs: Run[] = [];
    for (const job of jobs) runs.push(await collectRun(job, sources));
    const { usd: spend, unknownModels } = spendFromSpans(runs.flatMap((run) => run.spans));
    const outcomes = runs.filter((run) => rightSettled(world, run.invoice_id)).length;
    return { runs, spend, unknownModels, outcomes, mustNever: mustNeverBroken(world) };
  } finally {
    await employee?.stop();
    world.stop();
  }
}

const PAYMENTS_FOR_INVOICE = "SELECT amount_usd, approved_by FROM payments WHERE invoice_id = ?";
const DISPUTES_FOR_INVOICE =
  "SELECT reason_code, amount_usd, approved_by FROM disputes WHERE invoice_id = ?";

export function ledgerRows(world: World, invoiceId: string): LedgerRows {
  const payments = world.db.query(PAYMENTS_FOR_INVOICE).all(invoiceId) as Payment[];
  const disputes = world.db.query(DISPUTES_FOR_INVOICE).all(invoiceId) as Dispute[];
  return { payments, disputes };
}

function rightSettled(world: World, invoiceId: string): boolean {
  return ledgerMatches(truth(world, invoiceId), ledgerRows(world, invoiceId));
}

const LOADS_PAID_MORE_THAN_ONCE =
  "SELECT invoices.load_id, COUNT(*) AS times FROM payments " +
  "JOIN invoices ON invoices.invoice_id = payments.invoice_id " +
  "GROUP BY invoices.load_id HAVING COUNT(*) > 1";

type PaidInvoice = { invoice_id: string; amount_usd: number };

// Why this payment is more than the evidence allows, or null when it is allowed.
function overpayment(world: World, payment: PaidInvoice): string | null {
  const expected = truth(world, payment.invoice_id);
  const allowedAmount = expected.amount_usd + ONE_CENT;
  if (expected.action === "pay" && payment.amount_usd <= allowedAmount) return null;
  const allowed = expected.action === "pay" ? `USD ${expected.amount_usd}` : "no payment";
  return `${payment.invoice_id} paid USD ${payment.amount_usd}, the evidence allows ${allowed}`;
}

// The hire letter's must-never: a load paid twice, or a payment above what the evidence allows.
export function mustNeverBroken(world: World): string[] {
  const broken: string[] = [];
  const loadsPaidTwice = world.db.query(LOADS_PAID_MORE_THAN_ONCE).all() as {
    load_id: string;
    times: number;
  }[];
  for (const load of loadsPaidTwice) broken.push(`load ${load.load_id} paid ${load.times} times`);
  const paymentsQuery = world.db.query("SELECT invoice_id, amount_usd FROM payments");
  for (const payment of paymentsQuery.all() as PaidInvoice[]) {
    const problem = overpayment(world, payment);
    if (problem) broken.push(problem);
  }
  return broken;
}

// ---------- Acceptance cases from Design ----------
// Each case names rows the ledger (or GET /approvals) must hold after its job.
export type CaseResult = { name: string; pass: boolean; why: string };
type Row = Record<string, unknown>;
type ExpectedRows = { table?: string; route?: string; where?: Row; values?: Row; rows: number };
type AcceptanceCase = {
  name: string;
  job: { invoice_id: string; decide?: { decision: "approve" | "decline"; by: string } };
  expect?: ExpectedRows[];
};
type CaseView = { world: World; nowWaiting: EmployeeApproval[]; jobId: string };
type JobIdOf = (acceptanceCase: AcceptanceCase) => string;

function readCases(file: string): AcceptanceCase[] {
  const document = Bun.YAML.parse(readFileSync(file, "utf8")) as { cases?: unknown } | null;
  return Array.isArray(document?.cases) ? document.cases : [];
}

async function startCases(api: Api, cases: AcceptanceCase[], jobIdOf: JobIdOf): Promise<void> {
  for (const acceptanceCase of cases) {
    await api.startJob({
      job_id: jobIdOf(acceptanceCase),
      tenant: "kaas-freight",
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: acceptanceCase.job.invoice_id },
    });
  }
  for (const acceptanceCase of cases) await api.waitJob(jobIdOf(acceptanceCase), { ms: 15_000 });
}

// A case that says who decides gets that decision on the approval its job waits on.
async function decideCases(api: Api, cases: AcceptanceCase[], jobIdOf: JobIdOf): Promise<void> {
  const waiting = await waitingApprovals(api);
  for (const acceptanceCase of cases) {
    const decide = acceptanceCase.job.decide;
    if (!decide) continue;
    const jobId = jobIdOf(acceptanceCase);
    const approval = waiting.find((candidate) => candidate.job_id === jobId);
    if (!approval) continue;
    await api.decide(approval.approval_id, decide.decision, decide.by);
    await api.waitJob(jobId);
  }
}

function rowsToSearch(expected: ExpectedRows, view: CaseView): Row[] {
  if (expected.route) return view.nowWaiting.filter((approval) => approval.job_id === view.jobId);
  return view.world.db.query(`SELECT * FROM ${expected.table}`).all() as Row[];
}

const matchesEvery = (row: Row, wanted: Row = {}) =>
  Object.entries(wanted).every(([column, value]) => String(row[column]) === String(value));

// Why the rows this expectation names are wrong, or "" when they are right.
function rowsProblem(expected: ExpectedRows, view: CaseView): string {
  const place = expected.table ?? expected.route;
  const matching = rowsToSearch(expected, view).filter((row) => matchesEvery(row, expected.where));
  if (matching.length !== expected.rows) {
    const where = JSON.stringify(expected.where);
    const found = `${matching.length} row(s)`;
    return `${place} where ${where} has ${found}, the case expects ${expected.rows}`;
  }
  const wrongValue = Object.entries(expected.values ?? {}).find(
    ([column, value]) => !matching.every((row) => String(row[column]) === String(value)),
  );
  if (!wrongValue) return "";
  const [column, value] = wrongValue;
  return `${place} ${column} is ${matching[0]?.[column]}, the case expects ${value}`;
}

function caseProblem(acceptanceCase: AcceptanceCase, view: CaseView): string {
  for (const expected of acceptanceCase.expect ?? []) {
    const problem = rowsProblem(expected, view);
    if (problem) return problem;
  }
  return "";
}

export async function runAcceptance(
  file: string,
  employeeDir: string,
  chosenModel: Model,
): Promise<CaseResult[]> {
  const cases = readCases(file);
  const world = checkerWorld();
  let employee: Running | null = null;
  try {
    const env = modelEnvironment(chosenModel);
    employee = await startEmployee(employeeDir, world.url, { env });
    const api = contract(employee);
    const tag = shortRandomTag();
    const jobIdOf = (acceptanceCase: AcceptanceCase) => `acceptance-${tag}-${acceptanceCase.name}`;
    await startCases(api, cases, jobIdOf);
    await decideCases(api, cases, jobIdOf);
    const nowWaiting = await waitingApprovals(api);
    return cases.map((acceptanceCase) => {
      const view = { world, nowWaiting, jobId: jobIdOf(acceptanceCase) };
      const why = caseProblem(acceptanceCase, view);
      return { name: acceptanceCase.name, pass: !why, why };
    });
  } finally {
    await employee?.stop();
    world.stop();
  }
}

// ---------- The swap gate ----------
export type GateConfig = {
  dir: string;
  employee: string;
  current: string;
  candidate: string;
  evals: string;
  acceptance: string | null;
  invoices: string[];
  trials: number;
  refuse_when: {
    eval_pass_share_below: number;
    must_never: boolean;
    cost_per_outcome_rises: boolean;
  };
};
type GateToml = {
  employee?: string;
  current?: string;
  candidate?: string;
  evals?: string;
  acceptance?: string;
  invoices?: unknown;
  trials?: number;
  refuse_when?: Partial<GateConfig["refuse_when"]>;
};

function gateConfigFrom(toml: GateToml, file: string): GateConfig {
  const folder = dirname(file);
  const pathFrom = (path: string | undefined) => {
    if (!path) return "";
    return isAbsolute(path) ? path : resolve(folder, path);
  };
  const refuseWhen = toml.refuse_when;
  return {
    dir: folder,
    employee: pathFrom(toml.employee) || KIT,
    current: String(toml.current ?? ""),
    candidate: String(toml.candidate ?? ""),
    evals: pathFrom(toml.evals),
    acceptance: toml.acceptance ? pathFrom(toml.acceptance) : null,
    invoices: Array.isArray(toml.invoices) ? toml.invoices.map(String) : [],
    trials: Number(toml.trials ?? 0),
    refuse_when: {
      eval_pass_share_below: Number(refuseWhen?.eval_pass_share_below ?? 1),
      must_never: refuseWhen?.must_never !== false,
      cost_per_outcome_rises: refuseWhen?.cost_per_outcome_rises !== false,
    },
  };
}

function modelProblems(config: GateConfig): string[] {
  const problems: string[] = [];
  for (const side of ["current", "candidate"] as const) {
    if (model(config[side])) continue;
    const choices = modelNames().join(", ");
    problems.push(`${side} = "${config[side]}" is not a recorded model; use one of ${choices}`);
  }
  if (config.current === config.candidate) {
    problems.push("current and candidate are the same model");
  }
  return problems;
}

function settingProblems(config: GateConfig, toml: GateToml): string[] {
  const problems: string[] = [];
  if (!config.evals || !existsSync(config.evals)) {
    problems.push(`evals = "${toml.evals ?? ""}" is not a folder`);
  }
  if (config.acceptance && !existsSync(config.acceptance)) {
    problems.push(`acceptance = "${toml.acceptance}" is not a file`);
  }
  if (config.trials < 3) {
    problems.push(`trials = ${config.trials}; run each model at least 3 times`);
  }
  if (config.invoices.length === 0) {
    problems.push("invoices is empty; list the invoices the gate runs");
  }
  if (!existsSync(join(config.employee, "employee.toml"))) {
    problems.push(`employee = "${toml.employee}" has no employee.toml`);
  }
  return problems;
}

export function readGate(folder: string): { config: GateConfig | null; problems: string[] } {
  const file = find(folder, "gate.toml", "run-the-swap-gate");
  if (!file) return { config: null, problems: ["there is no gate.toml"] };
  let toml: GateToml;
  try {
    toml = Bun.TOML.parse(readFileSync(file, "utf8")) as GateToml;
  } catch (error) {
    return { config: null, problems: [`gate.toml does not parse: ${(error as Error).message}`] };
  }
  const config = gateConfigFrom(toml, file);
  const problems = [...modelProblems(config), ...settingProblems(config, toml)];
  return { config, problems };
}

export type Side = {
  model: string;
  role: string;
  trials: number;
  runs: number;
  passShare: number;
  evalFails: string[];
  acceptanceFails: string[];
  mustNever: string[];
  spend: number;
  outcomes: number;
  costPerOutcome: number | null;
  unknownModels: string[];
};
export type GateReport = {
  decision: "allow" | "refuse";
  reasons: string[];
  current: Side;
  candidate: Side;
};

// What one model's trials add up to, while the trials run.
type Tally = {
  runs: number;
  passed: number;
  spend: number;
  outcomes: number;
  evalFails: Set<string>;
  acceptanceFails: Set<string>;
  mustNever: Set<string>;
  unknownModels: Set<string>;
};

function emptyTally(): Tally {
  return {
    runs: 0,
    passed: 0,
    spend: 0,
    outcomes: 0,
    evalFails: new Set(),
    acceptanceFails: new Set(),
    mustNever: new Set(),
    unknownModels: new Set(),
  };
}

// A run passes only when every eval passes on it.
function tallyEvals(run: Run, evals: Eval[], tally: Tally): void {
  tally.runs++;
  const results = evals.map((evalToRun) => ({ evalToRun, result: runEval(evalToRun, run) }));
  const failures = results.filter((entry) => !entry.result.pass);
  if (failures.length === 0) tally.passed++;
  for (const { evalToRun, result } of failures) {
    const why = result.why ?? result.error;
    tally.evalFails.add(`${evalToRun.mode} on ${run.invoice_id}: ${why}`);
  }
}

async function runOneTrial(
  config: GateConfig,
  chosenModel: Model,
  evals: Eval[],
  tally: Tally,
): Promise<void> {
  const fresh = await freshRuns(config.employee, chosenModel, config.invoices);
  tally.spend += fresh.spend;
  tally.outcomes += fresh.outcomes;
  for (const name of fresh.unknownModels) tally.unknownModels.add(name);
  for (const broken of fresh.mustNever) tally.mustNever.add(broken);
  for (const run of fresh.runs) tallyEvals(run, evals, tally);
  if (!config.acceptance) return;
  const results = await runAcceptance(config.acceptance, config.employee, chosenModel);
  for (const result of results) {
    if (!result.pass) tally.acceptanceFails.add(`${result.name}: ${result.why}`);
  }
}

function sideFrom(chosenModel: Model, trials: number, tally: Tally): Side {
  return {
    model: chosenModel.name,
    role: chosenModel.role,
    trials,
    runs: tally.runs,
    passShare: tally.runs ? tally.passed / tally.runs : 0,
    evalFails: [...tally.evalFails],
    acceptanceFails: [...tally.acceptanceFails],
    mustNever: [...tally.mustNever],
    spend: tally.spend / trials,
    outcomes: tally.outcomes / trials,
    costPerOutcome: tally.outcomes ? tally.spend / tally.outcomes : null,
    unknownModels: [...tally.unknownModels],
  };
}

async function measureSide(config: GateConfig, name: string): Promise<Side> {
  const chosenModel = model(name);
  if (!chosenModel) throw new Error(`${name} is not a recorded model`);
  const evals = await loadEvals(config.evals);
  const tally = emptyTally();
  for (let trial = 1; trial <= config.trials; trial++) {
    await runOneTrial(config, chosenModel, evals, tally);
  }
  return sideFrom(chosenModel, config.trials, tally);
}

// The same model on the same gate settings is measured once, however many checks ask.
const sideCache = new Map<string, Promise<Side>>();
function runSide(config: GateConfig, name: string): Promise<Side> {
  const { employee, evals, acceptance, invoices, trials } = config;
  const key = JSON.stringify([employee, name, evals, acceptance, invoices, trials]);
  let side = sideCache.get(key);
  if (!side) {
    side = measureSide(config, name);
    sideCache.set(key, side);
  }
  return side;
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

function evalReason(candidate: Side, lowestShare: number): string {
  const share = percent(candidate.passShare);
  const firstFail = candidate.evalFails[0] ?? "";
  const lowest = percent(lowestShare);
  const reason = `evals: ${share} of runs pass every eval, below ${lowest}. ${firstFail}`;
  return reason.trim();
}

function costRiseReason(current: Side, candidate: Side): string | null {
  const before = current.costPerOutcome;
  const after = candidate.costPerOutcome;
  if (before === null || after === null || after <= before) return null;
  return `cost: cost per outcome rises from ${usd(before)} to ${usd(after)}`;
}

function refusalReasons(current: Side, candidate: Side, refuseWhen: GateConfig["refuse_when"]) {
  const reasons: string[] = [];
  if (candidate.passShare < refuseWhen.eval_pass_share_below) {
    reasons.push(evalReason(candidate, refuseWhen.eval_pass_share_below));
  }
  if (candidate.acceptanceFails.length) {
    reasons.push(`acceptance: ${candidate.acceptanceFails[0]}`);
  }
  if (refuseWhen.must_never && candidate.mustNever.length) {
    reasons.push(`must-never: ${candidate.mustNever[0]}`);
  }
  if (candidate.unknownModels.length) {
    const unpriced = candidate.unknownModels.join(", ");
    reasons.push(
      `cost: ${unpriced} has no price in config/models.ts, so cost per outcome is unknown`,
    );
  }
  const costRise = costRiseReason(current, candidate);
  if (refuseWhen.cost_per_outcome_rises && costRise) reasons.push(costRise);
  return reasons;
}

export async function runGate(
  config: GateConfig,
  candidate = config.candidate,
): Promise<GateReport> {
  const currentSide = await runSide(config, config.current);
  const candidateSide = await runSide(config, candidate);
  const reasons = refusalReasons(currentSide, candidateSide, config.refuse_when);
  const decision = reasons.length ? "refuse" : "allow";
  return { decision, reasons, current: currentSide, candidate: candidateSide };
}

// One row of the gate's table: the model, then each measure under its heading.
function sideRow(side: Side): string {
  const cost = side.costPerOutcome === null ? "unknown" : usd(side.costPerOutcome);
  const passPercent = (side.passShare * 100).toFixed(1);
  const columns = [
    side.model.padEnd(26),
    side.role.padEnd(6),
    String(side.trials).padStart(6),
    `${passPercent.padStart(6)}%`,
    String(side.acceptanceFails.length).padStart(10),
    String(side.mustNever.length).padStart(10),
  ];
  return `  ${columns.join(" ")}   ${cost}`;
}

const GATE_HEADER = [
  "model".padEnd(26),
  "role".padEnd(6),
  "trials".padStart(6),
  "evals".padStart(7),
  "acceptance".padStart(10),
  "must-never".padStart(10),
];

export function printGate(report: GateReport) {
  console.log(`  ${GATE_HEADER.join(" ")}   cost per outcome`);
  console.log(`${sideRow(report.current)}   (current)`);
  console.log(`${sideRow(report.candidate)}   (candidate)`);
  console.log("");
  if (report.decision === "refuse") {
    console.log(`REFUSE ${report.candidate.model}:`);
    for (const reason of report.reasons) console.log(`  - ${reason}`);
    return;
  }
  const before = usd(report.current.costPerOutcome ?? 0);
  const after = usd(report.candidate.costPerOutcome ?? 0);
  console.log(
    `ALLOW  ${report.candidate.model}: every eval and acceptance case passes on every trial. ` +
      `Cost per outcome ${before} before, ${after} after.`,
  );
}

export const temporaryFolder = (purpose: string) =>
  mkdtempSync(join(tmpdir(), `operate-${purpose}-`));

export const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
