// An invoice for a load that was billed earlier is a duplicate: never paid, disputed as DUPLICATE.
import type { Run } from "../../../operate-lib";

export default function (run: Run): string | null {
  const earlier = run.other_invoices_on_load.find((o) => o.received_at < run.invoice.received_at);
  if (!earlier) return null;
  if (run.ledger.payments.length) return `${run.invoice_id} bills a load already billed on ${earlier.invoice_id}, and the ledger shows it paid`;
  if (run.ledger.disputes.some((d) => d.reason_code === "DUPLICATE")) return null;
  if (run.approvals.some((a) => a.action === "open_dispute" && a.status === "waiting")) return null;
  return `${run.invoice_id} bills a load already billed on ${earlier.invoice_id}; the ledger shows no DUPLICATE dispute`;
}
