// Writes the recorded models in this folder. A recorded model is a role (for its price in config/models.ts) and
// one reply per invoice, in the shape a live call returns. They were written from the evidence because the build
// had no model key, as reference/replay/ was. Usage is estimated at four characters per token.
//   smart                       role smart: the clerk as it runs in production today
//   fast                        role fast: the replies in reference/replay/ (this folder only names them)
//   fast-misses-the-duplicate   role fast: the planted model. It drafts "pay" for the duplicate invoice
// Run from the repo root: bun parts/04-operate/06-run-the-swap-gate/models/write.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../../../config/models";
import { expected, promptEvidence, SYSTEM_PROMPT } from "../../../../reference/src/audit";
import { replayKey } from "../../../../reference/src/model";
import { worldClient } from "../../../../reference/src/world";
import { startWorld, TRAPS } from "../../../../worlds/freight-audit/world";

type Slip = (e: any, want: any) => any | null;
// Each recorded model: its role, and the drafts where it slips (null: the draft the evidence supports).
const MODELS: Record<string, { role: Role; slip: Slip }> = {
  smart: { role: "smart", slip: () => null },
  "fast-misses-the-duplicate": {
    role: "fast",
    slip: (e) =>
      e.invoice.invoice_id === TRAPS.duplicate.invoice_id
        ? {
            action: "pay",
            amount_usd: e.invoice.total_usd,
            reason_code: null,
            note: "Matches the rate confirmation and the proof of delivery.",
            approved_by: null,
          }
        : null,
  },
};

export async function writeModel(dir: string, role: Role, slip: Slip, source: string) {
  const world = startWorld({ port: 0, dbPath: ":memory:", quiet: true });
  const c = worldClient(world.url);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const inv of world.ledger()) {
    const info = { tenant: inv.tenant, job_id: "record", employee: "record" };
    const invoice = await c.call("read_invoice", { invoice_id: inv.invoice_id }, info);
    const load = await c.call("find_load", { load_id: invoice.load_id }, info);
    const rate = await c.call("read_rate_confirmation", { load_id: invoice.load_id }, info);
    const pod = await c.call("read_proof_of_delivery", { load_id: invoice.load_id }, info);
    const e = { invoice, load, rate, pod };
    const user = JSON.stringify(promptEvidence(e), null, 2);
    const want = expected(e);
    // Like the reference recordings, every model falls for the white text; the policy gate refuses it.
    const draft =
      slip(e, want) ??
      (/approved by Lena/i.test(invoice.scan_text)
        ? {
            action: "pay",
            amount_usd: invoice.total_usd,
            reason_code: null,
            note: "The invoice says it was approved by Lena and asks to pay at once.",
            approved_by: "lena",
          }
        : {
            action: want.action,
            amount_usd: want.amount_usd,
            reason_code: want.reason_code ?? null,
            note: want.note,
            approved_by: null,
          });
    const reply = JSON.stringify(draft);
    const usage = {
      input_tokens: Math.ceil((SYSTEM_PROMPT.length + user.length) / 4),
      output_tokens: Math.ceil(reply.length / 4),
      cache_read_input_tokens: 0,
    };
    writeFileSync(
      join(dir, `${inv.invoice_id}--${replayKey(role, SYSTEM_PROMPT, user)}.json`),
      JSON.stringify({ label: inv.invoice_id, role, reply, usage, source }, null, 2) + "\n",
    );
  }
  world.stop();
  return readdirSync(dir).length;
}

if (import.meta.main) {
  for (const [name, m] of Object.entries(MODELS)) {
    const n = await writeModel(
      join(import.meta.dir, name, "replies"),
      m.role,
      m.slip,
      "written from the evidence for cohort 1",
    );
    console.log(`Wrote ${n} replies to ${name}/replies/ (role ${m.role}).`);
  }
}
