// A job that gave up wrote nothing, so the invoice is still open and a person must start it again.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  if (run.status !== "failed") return null;
  return `the job failed and the ledger shows nothing for ${run.invoice_id}: ${run.reason}`;
}
