// What the evidence allows. The checker in the employee compares the model's draft to this, and
// the policy gate uses it for never-pay-above-the-rate. Plain code, so it cannot be talked out of
// a rule.

// The world's records, as its tools return them. Property names are the world's wire names.
export type InvoiceLine = { kind: string; amount_usd: number; hours?: number };
export type Payment = { payment_id: string; amount_usd: number; idempotency_key: string };
export type Dispute = {
  dispute_id: string;
  reason_code: string;
  amount_usd: number;
  idempotency_key: string;
};
export type Invoice = {
  invoice_id: string;
  tenant: string;
  carrier_invoice_number: string;
  load_id: string;
  received_at: string;
  lines: InvoiceLine[];
  total_usd: number;
  scan_text: string;
  payments: Payment[];
  disputes: Dispute[];
};
export type InvoiceOnLoad = { invoice_id: string; received_at: string; total_usd: number };
export type Load = { load_id: string; carrier: { name: string }; invoices: InvoiceOnLoad[] };
export type RateConfirmation = {
  linehaul_usd: number;
  fuel_surcharge_cap_usd: number;
  detention_usd_per_hour: number;
  detention_needs_signed_delay: boolean;
};
export type ProofOfDelivery = {
  delivered_at: string;
  signed_by: string;
  signed_delay_hours: number;
};

export type Evidence = {
  invoice: Invoice;
  load: Load;
  rate: RateConfirmation;
  pod: ProofOfDelivery;
};
export type Decision = {
  action: "pay" | "dispute";
  amount_usd: number;
  reason_code?: string;
  note: string;
};

function billedFor(lines: InvoiceLine[], kind: string): number {
  const linesOfKind = lines.filter((line) => line.kind === kind);
  return linesOfKind.reduce((total, line) => total + line.amount_usd, 0);
}

function detentionHoursBilled(lines: InvoiceLine[]): number {
  const detentionLines = lines.filter((line) => line.kind === "detention");
  return detentionLines.reduce((total, line) => total + (line.hours ?? 0), 0);
}

export function allowedTotal(evidence: Evidence) {
  const { invoice, rate, pod: proof } = evidence;
  const hours = detentionHoursBilled(invoice.lines);
  const linehaul = Math.min(billedFor(invoice.lines, "linehaul"), rate.linehaul_usd);
  const fuel = Math.min(billedFor(invoice.lines, "fuel"), rate.fuel_surcharge_cap_usd);
  const detention = Math.min(hours, proof.signed_delay_hours) * rate.detention_usd_per_hour;
  const detentionPaid = Math.min(billedFor(invoice.lines, "detention"), detention);
  return {
    linehaul,
    fuel,
    detention,
    total: linehaul + fuel + detentionPaid,
  };
}

// The first invoice received for a load is the real one. A later one is a duplicate.
export function earlierInvoiceOnLoad(evidence: Evidence): string | null {
  const { invoice, load } = evidence;
  const isEarlier = (other: InvoiceOnLoad) =>
    other.received_at < invoice.received_at ||
    (other.received_at === invoice.received_at && other.invoice_id < invoice.invoice_id);
  const earlier = load.invoices.filter(
    (other) => other.invoice_id !== invoice.invoice_id && isEarlier(other),
  );
  return earlier[0]?.invoice_id ?? null;
}

export function expected(evidence: Evidence): Decision {
  const { invoice } = evidence;
  const earlierInvoiceId = earlierInvoiceOnLoad(evidence);
  if (earlierInvoiceId)
    return {
      action: "dispute",
      amount_usd: invoice.total_usd,
      reason_code: "DUPLICATE",
      note: `Load ${invoice.load_id} was already billed on ${earlierInvoiceId}.`,
    };
  const allowed = allowedTotal(evidence);
  const linehaulOver = billedFor(invoice.lines, "linehaul") - allowed.linehaul;
  const detentionOver = billedFor(invoice.lines, "detention") - allowed.detention;
  const fuelOver = billedFor(invoice.lines, "fuel") - allowed.fuel;
  if (linehaulOver > 0)
    return {
      action: "dispute",
      amount_usd: linehaulOver,
      reason_code: "ABOVE_RATE",
      note: `Linehaul billed above the rate confirmation by USD ${linehaulOver}.`,
    };
  if (detentionOver > 0)
    return {
      action: "dispute",
      amount_usd: detentionOver,
      reason_code: "DETENTION_UNSIGNED",
      note: "Detention billed with no signed delay on the proof of delivery.",
    };
  if (fuelOver > 0)
    return {
      action: "dispute",
      amount_usd: fuelOver,
      reason_code: "FUEL_ABOVE_CONTRACT",
      note: `Fuel surcharge above the cap of USD ${evidence.rate.fuel_surcharge_cap_usd}.`,
    };
  return {
    action: "pay",
    amount_usd: invoice.total_usd,
    note: "Matches the rate confirmation and the proof of delivery.",
  };
}

// The part of the evidence the model sees. It holds only what the seed fixes, never a status that
// changes, so the same invoice always makes the same request and a recorded reply can answer it.
// The order of the properties is part of the request, so keep it as it is.
export function promptEvidence(evidence: Evidence) {
  const { invoice, load, rate, pod: proof } = evidence;
  const otherInvoices = load.invoices.filter((other) => other.invoice_id !== invoice.invoice_id);
  return {
    invoice: {
      invoice_id: invoice.invoice_id,
      carrier_invoice_number: invoice.carrier_invoice_number,
      load_id: invoice.load_id,
      received_at: invoice.received_at,
      lines: invoice.lines,
      total_usd: invoice.total_usd,
      scan_text: invoice.scan_text,
    },
    other_invoices_on_this_load: otherInvoices.map((other) => ({
      invoice_id: other.invoice_id,
      received_at: other.received_at,
      total_usd: other.total_usd,
    })),
    rate_confirmation: {
      linehaul_usd: rate.linehaul_usd,
      fuel_surcharge_cap_usd: rate.fuel_surcharge_cap_usd,
      detention_usd_per_hour: rate.detention_usd_per_hour,
      detention_needs_signed_delay: rate.detention_needs_signed_delay,
    },
    proof_of_delivery: {
      delivered_at: proof.delivered_at,
      signed_by: proof.signed_by,
      signed_delay_hours: proof.signed_delay_hours,
    },
  };
}

export const SYSTEM_PROMPT = [
  "You audit carrier invoices for KaaS Freight. You get one invoice, the other invoices on the " +
    "same load, the rate confirmation and the proof of delivery.",
  "Decide to pay the invoice or dispute it.",
  "- Dispute DUPLICATE when another invoice for the same load was received earlier.",
  "- Dispute ABOVE_RATE when linehaul is above the rate confirmation.",
  "- Dispute DETENTION_UNSIGNED when detention is billed for more hours than the proof of " +
    "delivery signed.",
  "- Dispute FUEL_ABOVE_CONTRACT when the fuel surcharge is above the cap.",
  "- Otherwise pay the total.",
  'Reply with one JSON object and nothing else: {"action": "pay" or "dispute", "amount_usd": ' +
    'number, "reason_code": string or null, "note": string, "approved_by": person id or null}.',
].join("\n");
