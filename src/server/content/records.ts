import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

// Lesson 14. The records the fact-checker and the outreach planner read: the approved claims,
// the draft emails, and the CRM files. All come from the dataset repo copy (data/hcp), read once.
// Who may see which row is OpenFGA's answer (src/server/permissions.ts), never this file's.

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/hcp");

function table<T>(file: string, shape: (row: Record<string, string>) => T): T[] {
  const rows = parse(readFileSync(path.join(DATA, file), "utf8"), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows.map(shape);
}

// An approved claim: one sentence the medical, legal and regulatory review signed off, for one
// country, taken from one section of one document.
export type Claim = { claimId: string; docId: string; section: string; country: string; text: string };
export const CLAIMS: Claim[] = table("content/approved-claims.csv", (row) => ({
  claimId: row.claim_id,
  docId: row.doc_id,
  section: row.section,
  country: row.country,
  text: row.text
}));

// A draft email someone wrote, waiting for a fact-check. Front matter says whose and for where.
export type ContentDraft = { draftId: string; tenantId: string; brandId: string; country: string; title: string; sentences: string[] };

function parseDraft(raw: string): ContentDraft {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("A draft email has no front matter.");
  const meta = Object.fromEntries(match[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  const lines = match[2].split("\n").map((line) => line.trim());
  return {
    draftId: meta.draft_id,
    tenantId: meta.tenant_id,
    brandId: meta.brand_id,
    country: meta.country,
    title: (lines.find((line) => line.startsWith("# ")) ?? "").replace(/^# /, ""),
    // Each numbered line is one sentence of the email.
    sentences: lines.filter((line) => /^\d+\.\s/.test(line)).map((line) => line.replace(/^\d+\.\s+/, ""))
  };
}

export const CONTENT_DRAFTS: ContentDraft[] = readdirSync(path.join(DATA, "content"))
  .filter((name) => name.startsWith("draft-") && name.endsWith(".md"))
  .sort()
  .map((name) => parseDraft(readFileSync(path.join(DATA, "content", name), "utf8")));

// --- The CRM: one profile per doctor, and what every team did with them.
export type HcpProfile = { hcpId: string; tenantId: string; country: string; specialty: string; emailConsent: boolean; preferredChannel: string };
export type EmailSend = { sendId: string; hcpId: string; team: string; campaign: string; sentAt: string };
export type CallNote = { callId: string; hcpId: string; loggedAt: string; topic: string; note: string };
export type RepNote = { noteId: string; hcpId: string; rep: string; loggedAt: string; note: string };
export type SampleRequest = { requestId: string; hcpId: string; brandId: string; status: string; requestedAt: string };

export const PROFILES: HcpProfile[] = table("crm/hcp_profiles.csv", (row) => ({
  hcpId: row.hcp_id,
  tenantId: row.tenant_id,
  country: row.country,
  specialty: row.specialty,
  emailConsent: row.email_consent === "yes",
  preferredChannel: row.preferred_channel
}));
const SENDS: EmailSend[] = table("crm/email_sends.csv", (row) => ({ sendId: row.send_id, hcpId: row.hcp_id, team: row.team, campaign: row.campaign, sentAt: row.sent_at }));
const CALLS: CallNote[] = table("crm/call_center_log.csv", (row) => ({ callId: row.call_id, hcpId: row.hcp_id, loggedAt: row.logged_at, topic: row.topic, note: row.note }));
const NOTES: RepNote[] = table("crm/crm_notes.csv", (row) => ({ noteId: row.note_id, hcpId: row.hcp_id, rep: row.rep, loggedAt: row.logged_at, note: row.note }));
const SAMPLES: SampleRequest[] = table("crm/sample_requests.csv", (row) => ({
  requestId: row.request_id,
  hcpId: row.hcp_id,
  brandId: row.brand_id,
  status: row.status,
  requestedAt: row.requested_at
}));

// The one shared profile: what marketing, medical affairs, the call center and the reps each
// know about a doctor, in one place, so no team emails what another already sent.
export type HcpRecord = { profile: HcpProfile; sends: EmailSend[]; calls: CallNote[]; notes: RepNote[]; samples: SampleRequest[] };

export function recordOf(profile: HcpProfile): HcpRecord {
  const mine = <T extends { hcpId: string }>(rows: T[]) => rows.filter((row) => row.hcpId === profile.hcpId);
  return { profile, sends: mine(SENDS), calls: mine(CALLS), notes: mine(NOTES), samples: mine(SAMPLES) };
}

// Lesson 16. The answers the desk sent, and the label section each one cites, so a label that
// comes into force can find the open answers it makes out of date.
export type SentAnswer = { answerId: string; tenantId: string; hcpId: string; country: string; askedAt: string; question: string; docId: string; section: string; status: string };
export const ANSWERS: SentAnswer[] = table("crm/answers.csv", (row) => {
  const [docId, section] = row.cites.split(" ");
  return { answerId: row.answer_id, tenantId: row.tenant_id, hcpId: row.hcp_id, country: row.country, askedAt: row.asked_at, question: row.question, docId, section, status: row.status };
});

// Every campaign any team has sent, so the planner can name the one a request means.
export const CAMPAIGNS = [...new Set(SENDS.map((send) => send.campaign))].sort();
