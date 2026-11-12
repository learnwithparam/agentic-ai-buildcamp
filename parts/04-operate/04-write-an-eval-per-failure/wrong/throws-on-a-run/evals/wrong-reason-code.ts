// A planted mistake: it reads the first dispute without asking if there is one, so it throws on most runs.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  const code = run.ledger.disputes[0].reason_code;
  return code === "ABOVE_RATE" && run.invoice.lines.some((l) => l.kind !== "linehaul") ? `${run.invoice_id} disputed as ABOVE_RATE` : null;
}
