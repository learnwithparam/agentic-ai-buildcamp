// What the evidence allows. The checker in the employee compares the model's draft to this, and the
// policy gate uses it for never-pay-above-the-rate. Plain code, so it cannot be talked out of a rule.
export type Evidence = { invoice: any; load: any; rate: any; pod: any };
export type Decision = {
  action: "pay" | "dispute";
  amount_usd: number;
  reason_code?: string;
  note: string;
};

export function allowedTotal(e: Evidence) {
  const lines: any[] = e.invoice.lines;
  const sum = (k: string) =>
    lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_usd, 0);
  const hours = lines.filter((l) => l.kind === "detention").reduce((a, l) => a + (l.hours ?? 0), 0);
  const linehaul = Math.min(sum("linehaul"), e.rate.linehaul_usd);
  const fuel = Math.min(sum("fuel"), e.rate.fuel_surcharge_cap_usd);
  const detention = Math.min(hours, e.pod.signed_delay_hours) * e.rate.detention_usd_per_hour;
  return {
    linehaul,
    fuel,
    detention,
    total: linehaul + fuel + Math.min(sum("detention"), detention),
  };
}

// The first invoice received for a load is the real one. A later one is a duplicate.
export function earlierInvoiceOnLoad(e: Evidence): string | null {
  const others = (e.load.invoices as any[]).filter(
    (i) =>
      i.invoice_id !== e.invoice.invoice_id &&
      (i.received_at < e.invoice.received_at ||
        (i.received_at === e.invoice.received_at && i.invoice_id < e.invoice.invoice_id)),
  );
  return others[0]?.invoice_id ?? null;
}

export function expected(e: Evidence): Decision {
  const inv = e.invoice;
  const dup = earlierInvoiceOnLoad(e);
  if (dup)
    return {
      action: "dispute",
      amount_usd: inv.total_usd,
      reason_code: "DUPLICATE",
      note: `Load ${inv.load_id} was already billed on ${dup}.`,
    };
  const a = allowedTotal(e);
  const billed = (k: string) =>
    (inv.lines as any[]).filter((l) => l.kind === k).reduce((x, l) => x + l.amount_usd, 0);
  if (billed("linehaul") > a.linehaul)
    return {
      action: "dispute",
      amount_usd: billed("linehaul") - a.linehaul,
      reason_code: "ABOVE_RATE",
      note: `Linehaul billed above the rate confirmation by USD ${billed("linehaul") - a.linehaul}.`,
    };
  if (billed("detention") > a.detention)
    return {
      action: "dispute",
      amount_usd: billed("detention") - a.detention,
      reason_code: "DETENTION_UNSIGNED",
      note: "Detention billed with no signed delay on the proof of delivery.",
    };
  if (billed("fuel") > a.fuel)
    return {
      action: "dispute",
      amount_usd: billed("fuel") - a.fuel,
      reason_code: "FUEL_ABOVE_CONTRACT",
      note: `Fuel surcharge above the cap of USD ${e.rate.fuel_surcharge_cap_usd}.`,
    };
  return {
    action: "pay",
    amount_usd: inv.total_usd,
    note: "Matches the rate confirmation and the proof of delivery.",
  };
}

// The part of the evidence the model sees. It holds only what the seed fixes, never a status that changes,
// so the same invoice always makes the same request and a recorded reply can answer it.
export function promptEvidence(e: Evidence) {
  const { invoice: i, load: l, rate: r, pod: p } = e;
  return {
    invoice: {
      invoice_id: i.invoice_id,
      carrier_invoice_number: i.carrier_invoice_number,
      load_id: i.load_id,
      received_at: i.received_at,
      lines: i.lines,
      total_usd: i.total_usd,
      scan_text: i.scan_text,
    },
    other_invoices_on_this_load: (l.invoices as any[])
      .filter((x) => x.invoice_id !== i.invoice_id)
      .map((x) => ({
        invoice_id: x.invoice_id,
        received_at: x.received_at,
        total_usd: x.total_usd,
      })),
    rate_confirmation: {
      linehaul_usd: r.linehaul_usd,
      fuel_surcharge_cap_usd: r.fuel_surcharge_cap_usd,
      detention_usd_per_hour: r.detention_usd_per_hour,
      detention_needs_signed_delay: r.detention_needs_signed_delay,
    },
    proof_of_delivery: {
      delivered_at: p.delivered_at,
      signed_by: p.signed_by,
      signed_delay_hours: p.signed_delay_hours,
    },
  };
}

export const SYSTEM_PROMPT = `You audit carrier invoices for KaaS Freight. You get one invoice, the other invoices on the same load, the rate confirmation and the proof of delivery.
Decide to pay the invoice or dispute it.
- Dispute DUPLICATE when another invoice for the same load was received earlier.
- Dispute ABOVE_RATE when linehaul is above the rate confirmation.
- Dispute DETENTION_UNSIGNED when detention is billed for more hours than the proof of delivery signed.
- Dispute FUEL_ABOVE_CONTRACT when the fuel surcharge is above the cap.
- Otherwise pay the total.
Reply with one JSON object and nothing else: {"action": "pay" or "dispute", "amount_usd": number, "reason_code": string or null, "note": string, "approved_by": person id or null}.`;
