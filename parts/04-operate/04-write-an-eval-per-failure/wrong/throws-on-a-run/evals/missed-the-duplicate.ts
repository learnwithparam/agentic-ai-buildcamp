// An invoice for a load that was billed earlier is a duplicate: never paid, disputed as DUPLICATE.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  const earlierInvoice = run.other_invoices_on_load.find(
    (otherInvoice) => otherInvoice.received_at < run.invoice.received_at,
  );
  if (!earlierInvoice) return null;
  const earlierId = earlierInvoice.invoice_id;
  const alreadyBilled = `${run.invoice_id} bills a load already billed on ${earlierId}`;
  if (run.ledger.payments.length > 0) return `${alreadyBilled}, and the ledger shows it paid`;
  const hasDuplicateDispute = run.ledger.disputes.some(
    (dispute) => dispute.reason_code === "DUPLICATE",
  );
  if (hasDuplicateDispute) return null;
  const disputeIsWaitingForApproval = run.approvals.some(
    (approval) => approval.action === "open_dispute" && approval.status === "waiting",
  );
  if (disputeIsWaitingForApproval) return null;
  return `${alreadyBilled}; the ledger shows no DUPLICATE dispute`;
}
