// A planted mistake: it checks that a DUPLICATE dispute exists on every run, duplicate or not.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  const hasDuplicateDispute = run.ledger.disputes.some(
    (dispute) => dispute.reason_code === "DUPLICATE",
  );
  if (hasDuplicateDispute) return null;
  return `${run.invoice_id} has no DUPLICATE dispute`;
}
