// The naive employee: read each invoice, pay the total, try once more on an error, then say done.
// It trusts its own calls and never reads the ledger after a write.
// Run it with `bun run reference naive`.
import { randomUUID } from "node:crypto";
import type { Invoice } from "./src/audit";
import { ToolFailed, worldClient } from "./src/world";

export async function runNaive(worldUrl: string, invoiceIds: string[]) {
  const world = worldClient(worldUrl);
  const info = { tenant: "kaas-freight", job_id: "naive", employee: "naive-clerk" };
  for (const invoiceId of invoiceIds) {
    const invoice = await world.call<Invoice>("read_invoice", { invoice_id: invoiceId }, info);
    // The mistake: a new key on every try, so a payment that landed but timed out is paid again.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await world.call(
          "pay_invoice",
          { invoice_id: invoiceId, amount_usd: invoice.total_usd },
          { ...info, key: randomUUID() },
        );
        break;
      } catch (error) {
        if (!(error instanceof ToolFailed)) throw error;
      }
    }
  }
  return `All ${invoiceIds.length} invoices paid. Done.`;
}
