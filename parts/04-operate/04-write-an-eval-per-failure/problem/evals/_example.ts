// The shape of an eval. Copy this file to evals/<mode>.ts, one file per failure mode, named exactly like the mode
// in failure-modes.md. Files that start with _ are skipped.
//
// An eval is a code check on one run. It returns null when the run passes, or one sentence on why it fails.
// It reads what the world holds: run.ledger (the rows written for this invoice), run.approvals, the evidence
// (run.invoice, run.other_invoices_on_load, run.rate, run.proof_of_delivery) and run.spans. Never the reply.
import type { Run } from "../../../operate-lib";

export default function (run: Run): string | null {
  if (run.ledger.payments.length > 1) return `${run.invoice_id} is paid ${run.ledger.payments.length} times`;
  return null;
}
