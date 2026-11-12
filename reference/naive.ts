// The naive employee: read each invoice, pay the total, try once more on an error, then say done.
// It trusts its own calls and never reads the ledger after a write. Run it with `bun run reference naive`.
import { randomUUID } from "node:crypto";
import { worldClient, ToolFailed } from "./src/world";

export async function runNaive(worldUrl: string, invoiceIds: string[]) {
  const world = worldClient(worldUrl);
  const info = { tenant: "kaas-freight", job_id: "naive", employee: "naive-clerk" };
  for (const id of invoiceIds) {
    const inv = await world.call("read_invoice", { invoice_id: id }, info);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await world.call("pay_invoice", { invoice_id: id, amount_usd: inv.total_usd }, { ...info, key: randomUUID() });
        break;
      } catch (e) {
        if (!(e instanceof ToolFailed)) throw e;
      }
    }
  }
  return `All ${invoiceIds.length} invoices paid. Done.`;
}
