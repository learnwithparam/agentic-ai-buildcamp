// The checker's own copy of the world: a fresh in-memory ledger on a free port, so it never touches the
// world you left running on localhost:7700.
import { startWorld, TRAPS, type World } from "../../worlds/freight-audit/world";

export { TRAPS, type World };

export function checkerWorld(): World {
  return startWorld({
    port: 0,
    dbPath: ":memory:",
    timeoutMs: Number(process.env.CHECK_TIMEOUT_MS ?? 250),
  });
}

// What the evidence allows for an invoice, worked out by the checker from the ledger's own rows.
export function truth(
  world: World,
  invoiceId: string,
): { action: "pay" | "dispute"; amount_usd: number; reason_code: string | null } {
  const q = (sql: string, ...a: any[]) => world.db.query(sql).get(...a) as any;
  const inv = q("SELECT * FROM invoices WHERE invoice_id = ?", invoiceId);
  const rate = q("SELECT * FROM rate_confirmations WHERE load_id = ?", inv.load_id);
  const pod = q("SELECT * FROM proofs_of_delivery WHERE load_id = ?", inv.load_id);
  const earlier = q(
    "SELECT invoice_id FROM invoices WHERE load_id = ? AND (received_at < ? OR (received_at = ? AND invoice_id < ?))",
    inv.load_id,
    inv.received_at,
    inv.received_at,
    inv.invoice_id,
  );
  if (earlier) return { action: "dispute", amount_usd: inv.total_usd, reason_code: "DUPLICATE" };
  const lines = JSON.parse(inv.lines) as { kind: string; amount_usd: number; hours?: number }[];
  const sum = (k: string) =>
    lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_usd, 0);
  const hours = lines.filter((l) => l.kind === "detention").reduce((a, l) => a + (l.hours ?? 0), 0);
  const detentionAllowed = Math.min(hours, pod.signed_delay_hours) * rate.detention_usd_per_hour;
  if (sum("linehaul") > rate.linehaul_usd)
    return {
      action: "dispute",
      amount_usd: sum("linehaul") - rate.linehaul_usd,
      reason_code: "ABOVE_RATE",
    };
  if (sum("detention") > detentionAllowed)
    return {
      action: "dispute",
      amount_usd: sum("detention") - detentionAllowed,
      reason_code: "DETENTION_UNSIGNED",
    };
  if (sum("fuel") > rate.fuel_surcharge_cap_usd)
    return {
      action: "dispute",
      amount_usd: sum("fuel") - rate.fuel_surcharge_cap_usd,
      reason_code: "FUEL_ABOVE_CONTRACT",
    };
  return { action: "pay", amount_usd: inv.total_usd, reason_code: null };
}

export const paymentsFor = (world: World, id: string) =>
  world.payments().filter((p: any) => p.invoice_id === id);
export const disputesFor = (world: World, id: string) =>
  world.disputes().filter((d: any) => d.invoice_id === id);

// Does the ledger agree that this job's invoice is settled the way the evidence allows?
export function ledgerAgrees(world: World, id: string): boolean {
  const t = truth(world, id);
  const p = paymentsFor(world, id),
    d = disputesFor(world, id);
  if (t.action === "pay")
    return p.length === 1 && Math.abs(p[0].amount_usd - t.amount_usd) < 0.01 && d.length === 0;
  return p.length === 0 && d.length >= 1 && d[0].reason_code === t.reason_code;
}
