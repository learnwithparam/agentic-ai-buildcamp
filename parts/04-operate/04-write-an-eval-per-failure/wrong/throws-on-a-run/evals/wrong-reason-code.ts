// A planted mistake: it reads the first dispute without asking if there is one,
// so it throws on most runs.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  const firstReasonCode = run.ledger.disputes[0].reason_code;
  const billsMoreThanLinehaul = run.invoice.lines.some((line) => line.kind !== "linehaul");
  if (firstReasonCode === "ABOVE_RATE" && billsMoreThanLinehaul) {
    return `${run.invoice_id} disputed as ABOVE_RATE`;
  }
  return null;
}
