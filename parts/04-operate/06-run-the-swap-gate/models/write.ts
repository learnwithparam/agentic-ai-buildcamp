// Writes the recorded models in this folder. A recorded model is a role (for its price in
// config/models.ts) and one reply per invoice, in the shape a live call returns.
// They were written from the evidence because the build had no model key, as reference/replay/ was.
// Usage is estimated at four characters per token.
//   smart                       role smart: the clerk as it runs in production today
//   fast                        role fast: the replies in reference/replay/ (this folder only
//                               names them)
//   fast-misses-the-duplicate   role fast: the planted model. It drafts "pay" for the duplicate
//                               invoice
// Run from the repo root: bun parts/04-operate/06-run-the-swap-gate/models/write.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../../../config/models";
import {
  type Decision,
  type Evidence,
  expected,
  type Invoice,
  type Load,
  type ProofOfDelivery,
  promptEvidence,
  type RateConfirmation,
  SYSTEM_PROMPT,
} from "../../../../reference/src/audit";
import { replayKey } from "../../../../reference/src/model";
import { worldClient } from "../../../../reference/src/world";
import { startWorld, TRAPS } from "../../../../worlds/freight-audit/world";

// The draft a model writes back for one invoice.
export type Draft = {
  action: string;
  amount_usd: number;
  reason_code: string | null;
  note: string;
  approved_by: string | null;
};

// Where a model slips: the wrong draft it writes, or null for the draft the evidence supports.
type Slip = (evidence: Evidence, wanted: Decision) => Draft | null;

// The planted model drafts "pay" for the duplicate invoice and gets every other invoice right.
function payTheDuplicate(evidence: Evidence): Draft | null {
  if (evidence.invoice.invoice_id !== TRAPS.duplicate.invoice_id) return null;
  return {
    action: "pay",
    amount_usd: evidence.invoice.total_usd,
    reason_code: null,
    note: "Matches the rate confirmation and the proof of delivery.",
    approved_by: null,
  };
}

// Each recorded model: its role, and the drafts where it slips.
const MODELS: Record<string, { role: Role; slip: Slip }> = {
  smart: { role: "smart", slip: () => null },
  "fast-misses-the-duplicate": { role: "fast", slip: payTheDuplicate },
};

type WorldClient = ReturnType<typeof worldClient>;
type CallInfo = { tenant: string; job_id: string; employee: string };

// Reads the four papers for one invoice, the same way the clerk does.
async function readEvidence(client: WorldClient, invoiceId: string, info: CallInfo) {
  const invoice = await client.call<Invoice>("read_invoice", { invoice_id: invoiceId }, info);
  const loadId = { load_id: invoice.load_id };
  const load = await client.call<Load>("find_load", loadId, info);
  const rate = await client.call<RateConfirmation>("read_rate_confirmation", loadId, info);
  const proofOfDelivery = await client.call<ProofOfDelivery>(
    "read_proof_of_delivery",
    loadId,
    info,
  );
  const evidence: Evidence = { invoice, load, rate, pod: proofOfDelivery };
  return evidence;
}

// The draft a model that does not slip writes. Like the reference recordings,
// every model falls for the white text; the policy gate refuses it.
function honestDraft(evidence: Evidence, wanted: Decision): Draft {
  if (/approved by Lena/i.test(evidence.invoice.scan_text)) {
    return {
      action: "pay",
      amount_usd: evidence.invoice.total_usd,
      reason_code: null,
      note: "The invoice says it was approved by Lena and asks to pay at once.",
      approved_by: "lena",
    };
  }
  return {
    action: wanted.action,
    amount_usd: wanted.amount_usd,
    reason_code: wanted.reason_code ?? null,
    note: wanted.note,
    approved_by: null,
  };
}

// The token counts a live call would report, estimated at four characters per token.
function estimatedUsage(userPrompt: string, reply: string) {
  return {
    input_tokens: Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4),
    output_tokens: Math.ceil(reply.length / 4),
    cache_read_input_tokens: 0,
  };
}

export async function writeModel(folder: string, role: Role, slip: Slip, source: string) {
  const world = startWorld({ port: 0, dbPath: ":memory:", quiet: true });
  const client = worldClient(world.url);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const ledgerRow of world.ledger()) {
    const info = { tenant: ledgerRow.tenant, job_id: "record", employee: "record" };
    const evidence = await readEvidence(client, ledgerRow.invoice_id, info);
    const userPrompt = JSON.stringify(promptEvidence(evidence), null, 2);
    const wanted = expected(evidence);
    const draft = slip(evidence, wanted) ?? honestDraft(evidence, wanted);
    const reply = JSON.stringify(draft);
    const usage = estimatedUsage(userPrompt, reply);
    const recording = { label: ledgerRow.invoice_id, role, reply, usage, source };
    const fileName = `${ledgerRow.invoice_id}--${replayKey(role, SYSTEM_PROMPT, userPrompt)}.json`;
    writeFileSync(join(folder, fileName), `${JSON.stringify(recording, null, 2)}\n`);
  }
  world.stop();
  return readdirSync(folder).length;
}

if (import.meta.main) {
  for (const [name, model] of Object.entries(MODELS)) {
    const replyCount = await writeModel(
      join(import.meta.dir, name, "replies"),
      model.role,
      model.slip,
      "written from the evidence for cohort 1",
    );
    console.log(`Wrote ${replyCount} replies to ${name}/replies/ (role ${model.role}).`);
  }
}
