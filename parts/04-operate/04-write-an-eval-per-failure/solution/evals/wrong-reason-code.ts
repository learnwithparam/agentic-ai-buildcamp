// When the papers call for a dispute, the ledger must hold a dispute with that reason code.
// Duplicates have their own eval, missed-the-duplicate.
import type { Run } from "../../../operate-lib";

// The total amount the invoice bills on its lines of one kind, for example "fuel".
function amountBilled(run: Run, kind: string): number {
  const linesOfKind = run.invoice.lines.filter((line) => line.kind === kind);
  return linesOfKind.reduce((total, line) => total + line.amount_usd, 0);
}

// The detention hours the invoice bills, across all its detention lines.
function detentionHoursBilled(run: Run): number {
  const detentionLines = run.invoice.lines.filter((line) => line.kind === "detention");
  return detentionLines.reduce((total, line) => total + (line.hours ?? 0), 0);
}

export function reasonTheEvidenceGives(run: Run): string | null {
  // Only the delay the receiver signed for can be billed as detention.
  const signedHours = Math.min(detentionHoursBilled(run), run.proof_of_delivery.signed_delay_hours);
  const detentionAllowed = signedHours * run.rate.detention_usd_per_hour;
  if (amountBilled(run, "linehaul") > run.rate.linehaul_usd) return "ABOVE_RATE";
  if (amountBilled(run, "detention") > detentionAllowed) return "DETENTION_UNSIGNED";
  if (amountBilled(run, "fuel") > run.rate.fuel_surcharge_cap_usd) return "FUEL_ABOVE_CONTRACT";
  return null;
}

export default function (run: Run): string | null {
  const neededReason = reasonTheEvidenceGives(run);
  if (!neededReason) return null;
  const isDuplicate = run.other_invoices_on_load.some(
    (otherInvoice) => otherInvoice.received_at < run.invoice.received_at,
  );
  if (isDuplicate) return null;
  const reasonCodes = run.ledger.disputes.map((dispute) => dispute.reason_code);
  if (reasonCodes.includes(neededReason)) return null;
  const disputeIsWaitingForApproval = run.approvals.some(
    (approval) => approval.action === "open_dispute" && approval.status === "waiting",
  );
  if (disputeIsWaitingForApproval) return null;
  let ledgerShows = "no dispute";
  if (reasonCodes.length > 0) ledgerShows = reasonCodes.join(", ");
  const papersCallFor = `the papers call for a ${neededReason} dispute on ${run.invoice_id}`;
  return `${papersCallFor}; the ledger shows ${ledgerShows}`;
}
