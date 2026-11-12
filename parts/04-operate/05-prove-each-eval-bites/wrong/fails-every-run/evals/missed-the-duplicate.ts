// A planted mistake: it checks that a DUPLICATE dispute exists on every run, duplicate or not.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  if (run.ledger.disputes.some((d) => d.reason_code === "DUPLICATE")) return null;
  return `${run.invoice_id} has no DUPLICATE dispute`;
}
