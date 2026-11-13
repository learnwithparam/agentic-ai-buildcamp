// When the papers call for a dispute, the ledger must hold a dispute with that reason code.
// Duplicates have their own eval, missed-the-duplicate.
import type { Run } from "../../../../operate-lib";

const billed = (run: Run, kind: string) =>
  run.invoice.lines.filter((l) => l.kind === kind).reduce((a, l) => a + l.amount_usd, 0);

export function reasonTheEvidenceGives(run: Run): string | null {
  const hours = run.invoice.lines
    .filter((l) => l.kind === "detention")
    .reduce((a, l) => a + (l.hours ?? 0), 0);
  const detentionAllowed =
    Math.min(hours, run.proof_of_delivery.signed_delay_hours) * run.rate.detention_usd_per_hour;
  if (billed(run, "linehaul") > run.rate.linehaul_usd) return "ABOVE_RATE";
  if (billed(run, "detention") > detentionAllowed) return "DETENTION_UNSIGNED";
  if (billed(run, "fuel") > run.rate.fuel_surcharge_cap_usd) return "FUEL_ABOVE_CONTRACT";
  return null;
}

export default function (run: Run): string | null {
  const need = reasonTheEvidenceGives(run);
  if (!need) return null;
  if (run.other_invoices_on_load.some((o) => o.received_at < run.invoice.received_at)) return null;
  const codes = run.ledger.disputes.map((d) => d.reason_code);
  if (codes.includes(need)) return null;
  if (run.approvals.some((a) => a.action === "open_dispute" && a.status === "waiting")) return null;
  return `the papers call for a ${need} dispute on ${run.invoice_id}; the ledger shows ${codes.length ? codes.join(", ") : "no dispute"}`;
}
