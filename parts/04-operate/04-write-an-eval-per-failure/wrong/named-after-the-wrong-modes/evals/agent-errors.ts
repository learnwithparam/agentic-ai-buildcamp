// A planted mistake: one eval for every failure, named after no mode in failure-modes.md.
import type { Run } from "../../../../operate-lib";

export default function (run: Run): string | null {
  return run.status === "done" || run.status === "waiting_for_human" ? null : `${run.invoice_id} ended ${run.status}`;
}
