// The checker's own copy of the world: a fresh in-memory ledger on a free port, so it never touches
// the world you left running on localhost:7700.
import type { SQLQueryBindings } from "bun:sqlite";
import { startWorld, TRAPS, type World } from "../../worlds/freight-audit/world";

export { TRAPS, type World };

// Rows of the world's ledger tables, with the columns the checker reads.
type InvoiceRow = {
  invoice_id: string;
  load_id: string;
  received_at: string;
  total_usd: number;
  lines: string;
};
type RateConfirmationRow = {
  linehaul_usd: number;
  detention_usd_per_hour: number;
  fuel_surcharge_cap_usd: number;
};
type ProofOfDeliveryRow = { signed_delay_hours: number };
type InvoiceLine = { kind: string; amount_usd: number; hours?: number };
type Payment = {
  payment_id: string;
  invoice_id: string;
  tenant: string;
  amount_usd: number;
  approved_by: string | null;
  idempotency_key: string;
  caller: string;
  job_id: string;
  at: string;
};
type Dispute = {
  dispute_id: string;
  invoice_id: string;
  tenant: string;
  reason_code: string;
  amount_usd: number;
  note: string;
  approved_by: string | null;
  idempotency_key: string;
  caller: string;
  job_id: string;
  at: string;
};
type Evidence = { action: "pay" | "dispute"; amount_usd: number; reason_code: string | null };

export function checkerWorld(): World {
  return startWorld({
    port: 0,
    dbPath: ":memory:",
    timeoutMs: Number(process.env.CHECK_TIMEOUT_MS ?? 250),
  });
}

function oneRow<Row>(world: World, sql: string, ...bindings: SQLQueryBindings[]): Row {
  return world.db.query(sql).get(...bindings) as Row;
}

// Another invoice for the same load that arrived first makes this one a duplicate.
const EARLIER_INVOICE_FOR_LOAD =
  "SELECT invoice_id FROM invoices WHERE load_id = ? AND " +
  "(received_at < ? OR " +
  "(received_at = ? AND invoice_id < ?))";

function hasEarlierInvoice(world: World, invoice: InvoiceRow): boolean {
  const earlier = oneRow<{ invoice_id: string } | null>(
    world,
    EARLIER_INVOICE_FOR_LOAD,
    invoice.load_id,
    invoice.received_at,
    invoice.received_at,
    invoice.invoice_id,
  );
  return Boolean(earlier);
}

function linesTotal(lines: InvoiceLine[], kind: string): number {
  const ofKind = lines.filter((line) => line.kind === kind);
  return ofKind.reduce((total, line) => total + line.amount_usd, 0);
}

function detentionHours(lines: InvoiceLine[]): number {
  const detention = lines.filter((line) => line.kind === "detention");
  return detention.reduce((total, line) => total + (line.hours ?? 0), 0);
}

// The first line kind billed above what the rate confirmation and the signed POD allow.
function firstOvercharge(world: World, invoice: InvoiceRow): Evidence | null {
  const rate = oneRow<RateConfirmationRow>(
    world,
    "SELECT * FROM rate_confirmations WHERE load_id = ?",
    invoice.load_id,
  );
  const proof = oneRow<ProofOfDeliveryRow>(
    world,
    "SELECT * FROM proofs_of_delivery WHERE load_id = ?",
    invoice.load_id,
  );
  const lines = JSON.parse(invoice.lines) as InvoiceLine[];
  const signedHours = Math.min(detentionHours(lines), proof.signed_delay_hours);
  const limits = [
    { kind: "linehaul", allowed: rate.linehaul_usd, reason: "ABOVE_RATE" },
    {
      kind: "detention",
      allowed: signedHours * rate.detention_usd_per_hour,
      reason: "DETENTION_UNSIGNED",
    },
    { kind: "fuel", allowed: rate.fuel_surcharge_cap_usd, reason: "FUEL_ABOVE_CONTRACT" },
  ];
  for (const { kind, allowed, reason } of limits) {
    const billed = linesTotal(lines, kind);
    if (billed > allowed) {
      return { action: "dispute", amount_usd: billed - allowed, reason_code: reason };
    }
  }
  return null;
}

// What the evidence allows for an invoice, worked out by the checker from the ledger's own rows.
export function truth(world: World, invoiceId: string): Evidence {
  const invoice = oneRow<InvoiceRow>(
    world,
    "SELECT * FROM invoices WHERE invoice_id = ?",
    invoiceId,
  );
  if (hasEarlierInvoice(world, invoice)) {
    return { action: "dispute", amount_usd: invoice.total_usd, reason_code: "DUPLICATE" };
  }
  const overcharge = firstOvercharge(world, invoice);
  if (overcharge) return overcharge;
  return { action: "pay", amount_usd: invoice.total_usd, reason_code: null };
}

export const paymentsFor = (world: World, id: string): Payment[] => {
  const payments = world.payments() as Payment[];
  return payments.filter((payment) => payment.invoice_id === id);
};

export const disputesFor = (world: World, id: string): Dispute[] => {
  const disputes = world.disputes() as Dispute[];
  return disputes.filter((dispute) => dispute.invoice_id === id);
};

// Does the ledger agree that this job's invoice is settled the way the evidence allows?
export function ledgerAgrees(world: World, id: string): boolean {
  const evidence = truth(world, id);
  const payments = paymentsFor(world, id);
  const disputes = disputesFor(world, id);
  if (evidence.action === "pay") {
    const paidRightAmount =
      payments.length === 1 && Math.abs(payments[0].amount_usd - evidence.amount_usd) < 0.01;
    return paidRightAmount && disputes.length === 0;
  }
  return (
    payments.length === 0 &&
    disputes.length >= 1 &&
    disputes[0].reason_code === evidence.reason_code
  );
}
