// The freight audit world: KaaS Freight's ledger behind HTTP and MCP tools.
// Start it with `bun run world freight-audit`.
// Checks start their own copy with startWorld() on a free port.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerPage } from "./ledger-page";

export const SEED = join(import.meta.dir, "seed");
const seedJson = (name: string) => JSON.parse(readFileSync(join(SEED, name), "utf8"));
export const TRAPS = seedJson("traps.json");

export type WorldOptions = {
  port?: number; // 0 picks a free port
  dbPath?: string; // ":memory:" for checks
  timeoutMs?: number; // how long a planted timeout waits before it answers 504
  quiet?: boolean;
};

export type Faults = {
  // The first pay call per invoice writes, then times out.
  pay_times_out_after_write: string[];
  // The first N pay calls for an invoice time out and write nothing.
  pay_times_out_without_write: Record<string, number>;
  // The first pay call to any of these writes, then never answers.
  // The checker kills the employee here.
  pay_hangs_after_write: string[];
  // Every tool answers 503.
  outage: boolean;
};

type ToolSpec = { name: string; kind: string; description: string; input: Record<string, string> };

export const TOOLS: ToolSpec[] = [
  {
    name: "find_load",
    kind: "read",
    description: "A load with its carrier and every invoice billed against it.",
    input: { load_id: "string" },
  },
  {
    name: "read_invoice",
    kind: "read",
    description:
      "An invoice: its lines, total, status, payments, disputes " +
      "and the text read from its PDF scan.",
    input: { invoice_id: "string" },
  },
  {
    name: "read_rate_confirmation",
    kind: "read",
    description: "The agreed price for a load: linehaul, fuel surcharge cap, detention rate.",
    input: { load_id: "string" },
  },
  {
    name: "read_proof_of_delivery",
    kind: "read",
    description: "Who signed for the load, when, and any delay signed at the dock.",
    input: { load_id: "string" },
  },
  {
    name: "pay_invoice",
    kind: "final write",
    description:
      "Pay an invoice. Money leaves the account and cannot be taken back. " +
      "Needs an Idempotency-Key.",
    input: {
      invoice_id: "string",
      amount_usd: "number",
      approved_by: "string, optional: the person who approved it",
    },
  },
  {
    name: "open_dispute",
    kind: "undoable write",
    description: "Dispute an invoice with a reason code. Needs an Idempotency-Key.",
    input: {
      invoice_id: "string",
      reason_code: "DUPLICATE | ABOVE_RATE | DETENTION_UNSIGNED | FUEL_ABOVE_CONTRACT | OTHER",
      amount_usd: "number",
      note: "string",
      approved_by: "string, optional",
    },
  },
  {
    name: "email_carrier",
    kind: "undoable write",
    description: "Email a carrier about an invoice. Needs an Idempotency-Key.",
    input: { carrier_id: "string", subject: "string", body: "string" },
  },
];
export const REASON_CODES = [
  "DUPLICATE",
  "ABOVE_RATE",
  "DETENTION_UNSIGNED",
  "FUEL_ABOVE_CONTRACT",
  "OTHER",
];
const WRITE_TOOLS = ["pay_invoice", "open_dispute", "email_carrier"];

const SCHEMA = `
CREATE TABLE tenants (tenant TEXT PRIMARY KEY, name TEXT, business TEXT);
CREATE TABLE people (person_id TEXT PRIMARY KEY, tenant TEXT, name TEXT, role TEXT,
  may_approve INTEGER, pay_limit_usd REAL, dispute_limit_usd REAL, note TEXT);
CREATE TABLE carriers (carrier_id TEXT PRIMARY KEY, tenant TEXT, name TEXT, email TEXT);
CREATE TABLE loads (load_id TEXT PRIMARY KEY, tenant TEXT, carrier_id TEXT, shipper TEXT,
  origin TEXT, destination TEXT, pickup_date TEXT, delivery_date TEXT);
CREATE TABLE rate_confirmations (rate_id TEXT PRIMARY KEY, load_id TEXT, tenant TEXT,
  carrier_id TEXT, linehaul_usd REAL, fuel_surcharge_cap_usd REAL, detention_usd_per_hour REAL,
  detention_needs_signed_delay INTEGER);
CREATE TABLE proofs_of_delivery (pod_id TEXT PRIMARY KEY, load_id TEXT, tenant TEXT,
  delivered_at TEXT, signed_by TEXT, signed_delay_hours REAL, scan TEXT);
CREATE TABLE invoices (invoice_id TEXT PRIMARY KEY, tenant TEXT, carrier_id TEXT, load_id TEXT,
  carrier_invoice_number TEXT, received_at TEXT, total_usd REAL, lines TEXT, scan TEXT);
CREATE TABLE payments (payment_id TEXT PRIMARY KEY, invoice_id TEXT, tenant TEXT,
  amount_usd REAL, approved_by TEXT, idempotency_key TEXT, caller TEXT, job_id TEXT, at TEXT);
CREATE TABLE disputes (dispute_id TEXT PRIMARY KEY, invoice_id TEXT, tenant TEXT,
  reason_code TEXT, amount_usd REAL, note TEXT, approved_by TEXT, idempotency_key TEXT,
  caller TEXT, job_id TEXT, at TEXT);
CREATE TABLE emails (email_id TEXT PRIMARY KEY, carrier_id TEXT, tenant TEXT, subject TEXT,
  body TEXT, idempotency_key TEXT, caller TEXT, job_id TEXT, at TEXT);
CREATE TABLE idempotency (tenant TEXT, tool TEXT, key TEXT, request TEXT, response TEXT,
  PRIMARY KEY (tenant, tool, key));
CREATE TABLE write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, tenant TEXT, tool TEXT,
  caller TEXT, job_id TEXT, idempotency_key TEXT, request TEXT, result TEXT, replayed INTEGER,
  prev_hash TEXT, hash TEXT);
CREATE TABLE access_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, tenant TEXT,
  caller TEXT, job_id TEXT, tool TEXT, resource TEXT, resource_tenant TEXT,
  cross_tenant INTEGER, status INTEGER);
`;

// Rows as SQLite returns them. Booleans come back as 0 or 1, lists as JSON text.
type InvoiceRow = {
  invoice_id: string;
  tenant: string;
  carrier_id: string;
  load_id: string;
  carrier_invoice_number: string;
  received_at: string;
  total_usd: number;
  lines: string;
  scan: string;
};
type PaymentRow = {
  payment_id: string;
  invoice_id: string;
  tenant: string;
  amount_usd: number;
  approved_by: string | null;
  idempotency_key: string;
  caller: string;
  job_id: string | null;
  at: string;
};
type DisputeRow = {
  dispute_id: string;
  invoice_id: string;
  tenant: string;
  reason_code: string;
  amount_usd: number;
  note: string;
  approved_by: string | null;
  idempotency_key: string;
  caller: string;
  job_id: string | null;
  at: string;
};
type LoadRow = {
  load_id: string;
  tenant: string;
  carrier_id: string;
  shipper: string;
  origin: string;
  destination: string;
  pickup_date: string;
  delivery_date: string;
};
type CarrierRow = { carrier_id: string; tenant: string; name: string; email: string };
type RateConfirmationRow = {
  rate_id: string;
  load_id: string;
  tenant: string;
  carrier_id: string;
  linehaul_usd: number;
  fuel_surcharge_cap_usd: number;
  detention_usd_per_hour: number;
  detention_needs_signed_delay: number;
};
type ProofOfDeliveryRow = {
  pod_id: string;
  load_id: string;
  tenant: string;
  delivered_at: string;
  signed_by: string;
  signed_delay_hours: number;
  scan: string;
};
type PersonRow = { may_approve: number } & Record<string, unknown>;
type IdempotencyRow = {
  tenant: string;
  tool: string;
  key: string;
  request: string;
  response: string;
};
type WriteLogRow = {
  seq: number;
  at: string;
  tenant: string;
  tool: string;
  caller: string;
  job_id: string | null;
  idempotency_key: string | null;
  request: string;
  result: string;
  replayed: number;
  prev_hash: string;
  hash: string;
};
type AccessLogRow = { cross_tenant: number } & Record<string, unknown>;

// Who is calling a tool, read from the request headers.
type Caller = {
  tenant: string;
  employee: string;
  jobId: string | null;
  idempotencyKey: string | null;
};

// The arguments a tool call sends. A careless caller may send null instead of an object.
type ToolArgs = Record<string, unknown> | null;

// Everything one running world remembers between requests.
type WorldState = {
  db: Database;
  timeoutMs: number;
  faults: Faults;
  payAttempts: Map<string, number>;
  hasHung: boolean;
  idCounter: number;
  timers: Set<ReturnType<typeof setTimeout>>;
};

const PAYMENT_TIMEOUT = "the payment service did not answer in time";
const HANG_MS = 10 * 60_000;

// The text a scan reader gets from a PDF: every string drawn on the page, in order,
// whatever its colour.
export function pdfText(path: string): string {
  const raw = readFileSync(path, "latin1");
  const drawnStrings = [...raw.matchAll(/\((.*?)(?<!\\)\) Tj/g)];
  const texts = drawnStrings.map((match) => match[1].replace(/\\([()\\])/g, "$1"));
  return texts.filter((text) => text.trim()).join("\n");
}

class ToolError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function queryOne<Row>(db: Database, sql: string, ...params: SQLQueryBindings[]): Row | null {
  return db.query<Row, SQLQueryBindings[]>(sql).get(...params);
}

function queryAll<Row>(db: Database, sql: string, ...params: SQLQueryBindings[]): Row[] {
  return db.query<Row, SQLQueryBindings[]>(sql).all(...params);
}

const now = () => new Date().toISOString();

function nextId(state: WorldState, prefix: string): string {
  state.idCounter += 1;
  return `${prefix}-${String(state.idCounter).padStart(4, "0")}`;
}

// --- Seeding -----------------------------------------------------------------------------------

// SQLite has no booleans or lists: true becomes 1, and an object or list becomes JSON text.
function toSqlValue(value: unknown): SQLQueryBindings {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value as SQLQueryBindings;
}

function insertRows(db: Database, table: string, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(",");
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`;
    const values = columns.map((column) => toSqlValue(row[column]));
    db.query(sql).run(...values);
  }
}

function dropAllTables(db: Database) {
  const tables = queryAll<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table.name}`);
}

// Each invoice is its own file. The ledger keeps every field but the currency.
function seedInvoices(): Record<string, unknown>[] {
  const invoicesDir = join(SEED, "invoices");
  const fileNames = readdirSync(invoicesDir).sort();
  return fileNames.map((fileName) => {
    const { currency, ...invoice } = JSON.parse(readFileSync(join(invoicesDir, fileName), "utf8"));
    return invoice;
  });
}

function startingFaults(): Faults {
  return {
    pay_times_out_after_write: [TRAPS.pay_times_out_after_write.invoice_id],
    pay_times_out_without_write: { [TRAPS.pay_times_out_twice_without_write.invoice_id]: 2 },
    pay_hangs_after_write: [],
    outage: false,
  };
}

function resetWorld(state: WorldState) {
  const { db } = state;
  dropAllTables(db);
  db.exec(SCHEMA);
  insertRows(db, "tenants", seedJson("tenants.json"));
  insertRows(db, "people", seedJson("people.json"));
  insertRows(db, "carriers", seedJson("carriers.json"));
  insertRows(db, "loads", seedJson("loads.json"));
  insertRows(db, "rate_confirmations", seedJson("rate-confirmations.json"));
  insertRows(db, "proofs_of_delivery", seedJson("proofs-of-delivery.json"));
  insertRows(db, "invoices", seedInvoices());
  state.faults = startingFaults();
  state.payAttempts = new Map();
  state.hasHung = false;
  state.idCounter = 0;
}

// --- Reading the ledger ------------------------------------------------------------------------

function invoiceStatus(paymentCount: number, disputeCount: number): string {
  if (paymentCount) return "paid";
  if (disputeCount) return "disputed";
  return "open";
}

function invoiceView(db: Database, invoice: InvoiceRow) {
  const payments = queryAll<Partial<PaymentRow>>(
    db,
    "SELECT payment_id, amount_usd, approved_by, idempotency_key, at " +
      "FROM payments WHERE invoice_id = ? ORDER BY at",
    invoice.invoice_id,
  );
  const disputes = queryAll<Partial<DisputeRow>>(
    db,
    "SELECT dispute_id, reason_code, amount_usd, note, approved_by, idempotency_key, at " +
      "FROM disputes WHERE invoice_id = ? ORDER BY at",
    invoice.invoice_id,
  );
  const status = invoiceStatus(payments.length, disputes.length);
  return { ...invoice, lines: JSON.parse(invoice.lines), status, payments, disputes };
}

function readLedger(db: Database) {
  const invoices = queryAll<InvoiceRow>(db, "SELECT * FROM invoices ORDER BY invoice_id");
  return invoices.map((invoice) => invoiceView(db, invoice));
}

function readWriteLog(db: Database) {
  const rows = queryAll<WriteLogRow>(db, "SELECT * FROM write_log ORDER BY seq");
  return rows.map((row) => ({
    ...row,
    request: JSON.parse(row.request),
    result: JSON.parse(row.result),
    replayed: Boolean(row.replayed),
  }));
}

function readAccessLog(db: Database) {
  const rows = queryAll<AccessLogRow>(db, "SELECT * FROM access_log ORDER BY seq");
  return rows.map((row) => ({ ...row, cross_tenant: Boolean(row.cross_tenant) }));
}

function readPeople(db: Database) {
  const people = queryAll<PersonRow>(db, "SELECT * FROM people");
  return people.map((person) => ({ ...person, may_approve: Boolean(person.may_approve) }));
}

// --- The two logs ------------------------------------------------------------------------------

type Access = { tool: string; resource: string; resourceTenant: string | null; status: number };

function logAccess(db: Database, caller: Caller, access: Access) {
  const crossTenant = access.resourceTenant && access.resourceTenant !== caller.tenant ? 1 : 0;
  db.query(
    "INSERT INTO access_log (at, tenant, caller, job_id, tool, resource, resource_tenant, " +
      "cross_tenant, status) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    now(),
    caller.tenant,
    caller.employee,
    caller.jobId,
    access.tool,
    access.resource,
    access.resourceTenant,
    crossTenant,
    access.status,
  );
}

type WriteEntry = { tool: string; request: unknown; result: unknown; replayed: boolean };

// Each write log row hashes the row before it, so an edited row breaks the chain.
function chainHash(previousHash: string, body: string): string {
  return createHash("sha256")
    .update(previousHash + body)
    .digest("hex");
}

function logWrite(db: Database, caller: Caller, entry: WriteEntry) {
  const lastRow = queryOne<{ hash: string }>(
    db,
    "SELECT hash FROM write_log ORDER BY seq DESC LIMIT 1",
  );
  const previousHash = lastRow?.hash ?? "genesis";
  const writtenAt = now();
  const body = JSON.stringify({
    at: writtenAt,
    tenant: caller.tenant,
    tool: entry.tool,
    caller: caller.employee,
    job_id: caller.jobId,
    key: caller.idempotencyKey,
    request: entry.request,
    result: entry.result,
    replayed: entry.replayed,
  });
  db.query(
    "INSERT INTO write_log (at, tenant, tool, caller, job_id, idempotency_key, request, result, " +
      "replayed, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    writtenAt,
    caller.tenant,
    entry.tool,
    caller.employee,
    caller.jobId,
    caller.idempotencyKey,
    JSON.stringify(entry.request),
    JSON.stringify(entry.result),
    entry.replayed ? 1 : 0,
    previousHash,
    chainHash(previousHash, body),
  );
}

function verifyChain(db: Database): boolean {
  let previousHash = "genesis";
  for (const row of queryAll<WriteLogRow>(db, "SELECT * FROM write_log ORDER BY seq")) {
    const body = JSON.stringify({
      at: row.at,
      tenant: row.tenant,
      tool: row.tool,
      caller: row.caller,
      job_id: row.job_id,
      key: row.idempotency_key,
      request: JSON.parse(row.request),
      result: JSON.parse(row.result),
      replayed: Boolean(row.replayed),
    });
    if (row.prev_hash !== previousHash) return false;
    if (chainHash(previousHash, body) !== row.hash) return false;
    previousHash = row.hash;
  }
  return true;
}

// --- Read tools --------------------------------------------------------------------------------

function need(args: ToolArgs, field: string): SQLQueryBindings {
  const value = args?.[field];
  if (value === undefined || value === "") throw new ToolError(400, `missing "${field}"`);
  return value as SQLQueryBindings;
}

function optional(args: ToolArgs, field: string): SQLQueryBindings {
  return (args?.[field] ?? null) as SQLQueryBindings;
}

type RowLookup = { tool: string; sql: string; key: SQLQueryBindings; what: string };

// Every read is logged, with the tenant that owns the row, so a cross-tenant read shows up.
function readRow<Row extends { tenant: string }>(
  db: Database,
  caller: Caller,
  lookup: RowLookup,
): Row {
  const row = queryOne<Row>(db, lookup.sql, lookup.key);
  logAccess(db, caller, {
    tool: lookup.tool,
    resource: lookup.key as string,
    resourceTenant: row?.tenant ?? null,
    status: row ? 200 : 404,
  });
  if (!row) throw new ToolError(404, `no ${lookup.what} ${lookup.key}`);
  return row;
}

type ReadTool = (db: Database, caller: Caller, args: ToolArgs) => Record<string, unknown>;

function readInvoice(db: Database, caller: Caller, args: ToolArgs) {
  const invoice = readRow<InvoiceRow>(db, caller, {
    tool: "read_invoice",
    sql: "SELECT * FROM invoices WHERE invoice_id = ?",
    key: need(args, "invoice_id"),
    what: "invoice",
  });
  return { ...invoiceView(db, invoice), scan_text: pdfText(join(SEED, invoice.scan)) };
}

function findLoad(db: Database, caller: Caller, args: ToolArgs) {
  const load = readRow<LoadRow>(db, caller, {
    tool: "find_load",
    sql: "SELECT * FROM loads WHERE load_id = ?",
    key: need(args, "load_id"),
    what: "load",
  });
  const carrier = queryOne(db, "SELECT * FROM carriers WHERE carrier_id = ?", load.carrier_id);
  const invoiceRows = queryAll<InvoiceRow>(
    db,
    "SELECT * FROM invoices WHERE load_id = ? ORDER BY received_at, invoice_id",
    load.load_id,
  );
  const invoices = invoiceRows.map((invoiceRow) => {
    const invoice = invoiceView(db, invoiceRow);
    return {
      invoice_id: invoice.invoice_id,
      carrier_invoice_number: invoice.carrier_invoice_number,
      received_at: invoice.received_at,
      total_usd: invoice.total_usd,
      status: invoice.status,
    };
  });
  return { ...load, carrier, invoices };
}

function readRateConfirmation(db: Database, caller: Caller, args: ToolArgs) {
  const rate = readRow<RateConfirmationRow>(db, caller, {
    tool: "read_rate_confirmation",
    sql: "SELECT * FROM rate_confirmations WHERE load_id = ?",
    key: need(args, "load_id"),
    what: "rate confirmation for load",
  });
  return { ...rate, detention_needs_signed_delay: Boolean(rate.detention_needs_signed_delay) };
}

function readProofOfDelivery(db: Database, caller: Caller, args: ToolArgs) {
  const proof = readRow<ProofOfDeliveryRow>(db, caller, {
    tool: "read_proof_of_delivery",
    sql: "SELECT * FROM proofs_of_delivery WHERE load_id = ?",
    key: need(args, "load_id"),
    what: "proof of delivery for load",
  });
  return { ...proof, scan_text: pdfText(join(SEED, proof.scan)) };
}

const READ_TOOLS = new Map<string, ReadTool>([
  ["read_invoice", readInvoice],
  ["find_load", findLoad],
  ["read_rate_confirmation", readRateConfirmation],
  ["read_proof_of_delivery", readProofOfDelivery],
]);

// --- Write tools -------------------------------------------------------------------------------

type WriteResult = Record<string, unknown>;
type WriteCall = { tool: string; args: ToolArgs; caller: Caller };
type AfterWrite = "answer" | "timeout" | "hang";

function sleep(state: WorldState, waitMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      resolve();
    }, waitMs);
    state.timers.add(timer);
  });
}

// A write names the row it changes: a carrier for an email, an invoice for the rest.
function writeTargetId(db: Database, call: WriteCall): string {
  const { tool, args, caller } = call;
  let target: InvoiceRow | CarrierRow;
  if (tool === "email_carrier") {
    target = readRow<CarrierRow>(db, caller, {
      tool,
      sql: "SELECT * FROM carriers WHERE carrier_id = ?",
      key: need(args, "carrier_id"),
      what: "carrier",
    });
  } else {
    target = readRow<InvoiceRow>(db, caller, {
      tool,
      sql: "SELECT * FROM invoices WHERE invoice_id = ?",
      key: need(args, "invoice_id"),
      what: "invoice",
    });
  }
  if (target.tenant !== caller.tenant) {
    throw new ToolError(403, `${tool} on another tenant's row is not allowed`);
  }
  return "invoice_id" in target ? target.invoice_id : target.carrier_id;
}

// The faults planted for the checks: a payment that times out before or after it writes,
// or one that never answers.
async function plannedPaymentFault(state: WorldState, invoiceId: string): Promise<AfterWrite> {
  const attempt = (state.payAttempts.get(invoiceId) ?? 0) + 1;
  state.payAttempts.set(invoiceId, attempt);
  if (attempt <= (state.faults.pay_times_out_without_write[invoiceId] ?? 0)) {
    await sleep(state, state.timeoutMs);
    throw new ToolError(504, PAYMENT_TIMEOUT);
  }
  let afterWrite: AfterWrite = "answer";
  if (attempt === 1 && state.faults.pay_times_out_after_write.includes(invoiceId)) {
    afterWrite = "timeout";
  }
  if (!state.hasHung && state.faults.pay_hangs_after_write.includes(invoiceId)) {
    afterWrite = "hang";
    state.hasHung = true;
  }
  return afterWrite;
}

function recordPayment(state: WorldState, call: WriteCall, invoiceId: string): WriteResult {
  const { args, caller } = call;
  const writtenAt = now();
  const amount = Number(need(args, "amount_usd"));
  if (!(amount > 0)) throw new ToolError(400, "amount_usd must be a positive number");
  const paymentId = nextId(state, "PAY");
  const approvedBy = optional(args, "approved_by");
  state.db
    .query("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      paymentId,
      invoiceId,
      caller.tenant,
      amount,
      approvedBy,
      caller.idempotencyKey,
      caller.employee,
      caller.jobId,
      writtenAt,
    );
  return {
    payment_id: paymentId,
    invoice_id: invoiceId,
    amount_usd: amount,
    approved_by: approvedBy,
    at: writtenAt,
  };
}

function recordDispute(state: WorldState, call: WriteCall, invoiceId: string): WriteResult {
  const { args, caller } = call;
  const writtenAt = now();
  const code = need(args, "reason_code");
  if (typeof code !== "string" || !REASON_CODES.includes(code)) {
    throw new ToolError(400, `reason_code must be one of ${REASON_CODES.join(", ")}`);
  }
  const disputeId = nextId(state, "DSP");
  const amount = Number(args?.amount_usd ?? 0);
  state.db
    .query("INSERT INTO disputes VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      disputeId,
      invoiceId,
      caller.tenant,
      code,
      amount,
      String(args?.note ?? ""),
      optional(args, "approved_by"),
      caller.idempotencyKey,
      caller.employee,
      caller.jobId,
      writtenAt,
    );
  return {
    dispute_id: disputeId,
    invoice_id: invoiceId,
    reason_code: code,
    amount_usd: amount,
    at: writtenAt,
  };
}

function recordEmail(state: WorldState, call: WriteCall, carrierId: string): WriteResult {
  const { args, caller } = call;
  const writtenAt = now();
  // The id is taken before the subject and body are checked, so a rejected email uses one up.
  const emailId = nextId(state, "EML");
  state.db
    .query("INSERT INTO emails VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      emailId,
      carrierId,
      caller.tenant,
      need(args, "subject"),
      need(args, "body"),
      caller.idempotencyKey,
      caller.employee,
      caller.jobId,
      writtenAt,
    );
  return { email_id: emailId, carrier_id: carrierId, at: writtenAt };
}

function recordWrite(state: WorldState, call: WriteCall, targetId: string): WriteResult {
  if (call.tool === "pay_invoice") return recordPayment(state, call, targetId);
  if (call.tool === "open_dispute") return recordDispute(state, call, targetId);
  return recordEmail(state, call, targetId);
}

// The same Idempotency-Key with the same request answers what the first call answered.
function replayEarlierWrite(db: Database, call: WriteCall, request: string): WriteResult | null {
  const { tool, caller } = call;
  const earlier = queryOne<IdempotencyRow>(
    db,
    "SELECT * FROM idempotency WHERE tenant = ?" + " AND tool = ?" + " AND key = ?",
    caller.tenant,
    tool,
    caller.idempotencyKey,
  );
  if (!earlier) return null;
  if (earlier.request !== request) {
    throw new ToolError(409, "this Idempotency-Key was used with a different request");
  }
  const result = JSON.parse(earlier.response);
  logWrite(db, caller, { tool, request: call.args, result, replayed: true });
  return { ...result, replayed: true };
}

async function answerAfterWrite(state: WorldState, afterWrite: AfterWrite) {
  if (afterWrite === "timeout") {
    await sleep(state, state.timeoutMs);
    throw new ToolError(504, PAYMENT_TIMEOUT);
  }
  if (afterWrite === "hang") {
    await sleep(state, HANG_MS);
    throw new ToolError(504, PAYMENT_TIMEOUT);
  }
}

async function write(state: WorldState, call: WriteCall): Promise<WriteResult> {
  const { db } = state;
  const { tool, args, caller } = call;
  if (!caller.idempotencyKey) {
    throw new ToolError(400, "write tools need an Idempotency-Key header");
  }
  const request = JSON.stringify(args ?? {});
  const replayed = replayEarlierWrite(db, call, request);
  if (replayed) return replayed;

  const targetId = writeTargetId(db, call);
  let afterWrite: AfterWrite = "answer";
  if (tool === "pay_invoice") afterWrite = await plannedPaymentFault(state, targetId);

  const result = recordWrite(state, call, targetId);
  db.query("INSERT INTO idempotency VALUES (?,?,?,?,?)").run(
    caller.tenant,
    tool,
    caller.idempotencyKey,
    request,
    JSON.stringify(result),
  );
  logWrite(db, caller, { tool, request: args, result, replayed: false });
  await answerAfterWrite(state, afterWrite);
  return result;
}

async function callTool(state: WorldState, name: string, args: ToolArgs, caller: Caller) {
  if (state.faults.outage) throw new ToolError(503, "the ledger is down; try again later");
  if (!caller.tenant) throw new ToolError(400, "send the X-Tenant header with the job's tenant");
  const readTool = READ_TOOLS.get(name);
  if (readTool) return readTool(state.db, caller, args);
  if (WRITE_TOOLS.includes(name)) return write(state, { tool: name, args, caller });
  throw new ToolError(404, `no tool called ${name}`);
}

// --- MCP over HTTP: JSON-RPC 2.0 with initialize, tools/list and tools/call --------------------

type McpMessage = {
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

function mcpInputSchema(tool: ToolSpec) {
  const inputs = { ...tool.input, ...(tool.kind === "read" ? {} : { idempotency_key: "string" }) };
  const properties = Object.entries(inputs).map(([field, description]) => {
    const type = description.startsWith("number") ? "number" : "string";
    return [field, { type, description }];
  });
  const fields = Object.keys(tool.input);
  return {
    type: "object",
    properties: Object.fromEntries(properties),
    required: fields.filter((field) => !tool.input[field].includes("optional")),
  };
}

function mcpToolList() {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: `${tool.description} (${tool.kind})`,
      inputSchema: mcpInputSchema(tool),
    })),
  };
}

async function mcpToolCall(state: WorldState, message: McpMessage, caller: Caller) {
  const { name, arguments: args = {} } = message.params ?? {};
  const { idempotency_key: idempotencyKey, ...otherArgs } = args;
  const toolCaller = {
    ...caller,
    idempotencyKey: (idempotencyKey as string) ?? caller.idempotencyKey,
  };
  try {
    const answer = await callTool(state, name as string, otherArgs, toolCaller);
    return {
      content: [{ type: "text", text: JSON.stringify(answer) }],
      structuredContent: answer,
      isError: false,
    };
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error).message }], isError: true };
  }
}

async function answerMcp(state: WorldState, message: McpMessage, caller: Caller) {
  const answerWith = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    return answerWith({
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} },
      serverInfo: { name: "freight-audit-world", version: "1.0.0" },
    });
  }
  if (message.method?.startsWith("notifications/")) return null;
  if (message.method === "tools/list") return answerWith(mcpToolList());
  if (message.method === "tools/call") return answerWith(await mcpToolCall(state, message, caller));
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  };
}

// A batch is a list of messages. Notifications get no answer, so they drop out of the batch.
async function answerMcpBody(state: WorldState, body: unknown, caller: Caller) {
  if (!Array.isArray(body)) return answerMcp(state, body as McpMessage, caller);
  const answers = await Promise.all(body.map((message) => answerMcp(state, message, caller)));
  return answers.filter(Boolean);
}

// --- HTTP --------------------------------------------------------------------------------------

function reply(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function callerFrom(headers: Headers): Caller {
  return {
    tenant: headers.get("x-tenant") ?? "",
    employee: headers.get("x-employee") ?? "unknown",
    jobId: headers.get("x-job-id"),
    idempotencyKey: headers.get("idempotency-key"),
  };
}

// The pages a person opens in a browser.
function pageRoute(state: WorldState, path: string): Response | null {
  if (path === "/" || path === "/ledger") {
    return new Response(ledgerPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/health") return reply({ world: "freight-audit", ok: true });
  if (path === "/api/ledger") return reply(readLedger(state.db));
  if (path === "/people") return reply(readPeople(state.db));
  return null;
}

// The tools an employee calls, over plain HTTP or MCP.
async function toolRoute(state: WorldState, request: Request, path: string) {
  const caller = callerFrom(request.headers);
  if (path === "/tools" && request.method === "GET") return reply(TOOLS);
  if (path.startsWith("/tools/") && request.method === "POST") {
    const args = await request.json().catch(() => ({}));
    return reply(await callTool(state, path.slice(7), args, caller));
  }
  if (path === "/mcp" && request.method === "POST") {
    const answer = await answerMcpBody(state, await request.json(), caller);
    return answer ? reply(answer) : new Response(null, { status: 202 });
  }
  return null;
}

// The controls a check uses to reset the world, read its logs and plant faults.
async function adminRoute(state: WorldState, request: Request, path: string) {
  if (path === "/admin/reset" && request.method === "POST") {
    resetWorld(state);
    return reply({ reset: true });
  }
  if (path === "/admin/write-log") return reply(readWriteLog(state.db));
  if (path === "/admin/access-log") return reply(readAccessLog(state.db));
  if (path === "/admin/faults") {
    if (request.method === "POST") state.faults = { ...state.faults, ...(await request.json()) };
    return reply(state.faults);
  }
  return null;
}

async function answerRequest(state: WorldState, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const response =
      pageRoute(state, path) ??
      (await toolRoute(state, request, path)) ??
      (await adminRoute(state, request, path));
    return response ?? reply({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof ToolError) return reply({ error: error.message }, error.status);
    return reply({ error: (error as Error).message }, 500);
  }
}

// --- Starting a world --------------------------------------------------------------------------

function openDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

export function startWorld(options: WorldOptions = {}) {
  const state: WorldState = {
    db: openDatabase(options.dbPath ?? ":memory:"),
    timeoutMs: options.timeoutMs ?? 1500,
    faults: startingFaults(),
    payAttempts: new Map(),
    hasHung: false,
    idCounter: 0,
    timers: new Set(),
  };
  resetWorld(state);
  const { db } = state;
  const server = Bun.serve({
    port: options.port ?? 7700,
    idleTimeout: 0,
    fetch: (request) => answerRequest(state, request),
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    db,
    reset: () => resetWorld(state),
    ledger: () => readLedger(db),
    writeLog: () => readWriteLog(db),
    accessLog: () => readAccessLog(db),
    setFaults: (changes: Partial<Faults>) => {
      state.faults = { ...state.faults, ...changes };
    },
    faults: () => state.faults,
    verifyChain: () => verifyChain(db),
    payments: () => queryAll<PaymentRow>(db, "SELECT * FROM payments ORDER BY at"),
    disputes: () => queryAll<DisputeRow>(db, "SELECT * FROM disputes ORDER BY at"),
    stop: () => {
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
      server.stop(true);
      db.close();
    },
  };
}
export type World = ReturnType<typeof startWorld>;
