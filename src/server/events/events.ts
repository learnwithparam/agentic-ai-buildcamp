import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Lesson 16. What can happen outside a chat, as typed events. Each one says whose it is
// (tenant_id), and the webhook refuses one whose company is not the sender's (see webhook.ts).

const base = {
  event_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  tenant_id: z.string().min(1),
  brand_id: z.string().min(1),
  country: z.string().length(2),
  occurred_at: z.iso.datetime()
};

export const EventSchema = z.discriminatedUnion("type", [
  // A new label version comes into force, and replaces an older one of the same label.
  z.object({ ...base, type: z.literal("label.in_force"), doc_id: z.string(), replaces: z.string().optional() }),
  // An email reached the medical information inbox. raw_email is the whole message (RFC 5322).
  z.object({ ...base, type: z.literal("email.received"), raw_email: z.string().max(256_000) }),
  // Someone uploaded a draft email for the fact-checker.
  z.object({ ...base, type: z.literal("draft.uploaded"), draft_id: z.string() }),
  // The call center logged a call with a doctor.
  z.object({ ...base, type: z.literal("call.logged"), call_id: z.string(), hcp_id: z.string() })
]);
export type HcpEvent = z.infer<typeof EventSchema>;
export type EventType = HcpEvent["type"];

// What handling an event did. The report is what the event inbox shows and what the eval checks.
export type EventOutcome = "HANDLED" | "INSUFFICIENT_CONTEXT";
export type EventResult = { outcome: EventOutcome; report: string; itemIds: string[]; traceId?: string };

// What a second delivery of the same id gets back. It names no part of the first result: the
// sender learns only that the event was already taken, and nothing ran again.
export const duplicateReport = (eventId: string, deliveries: number) =>
  `DUPLICATE_EVENT: ${eventId} arrived again (delivery ${deliveries}). It was taken on its first delivery and is handled once, so nothing ran again ${cite(eventId)}.`;

// The day an event happened, which is the day its handler reads the labels for.
export const dayOf = (event: Pick<HcpEvent, "occurred_at">) => event.occurred_at.slice(0, 10);

export const cite = (id: string) => `[events, ${id}]`;

// --- The fixture events in the dataset repo copy (data/hcp/events), for the dataset run and
// for npm run events:send. A fixture names its email by file; what is sent carries the email
// itself, as an inbound mail provider does, so the server never opens a file a request names.
const EVENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/hcp/events");

type Fixture = Record<string, unknown> & { event_id: string; file?: string; note?: string };

export function fixtureEvents(): Fixture[] {
  return readFileSync(path.join(EVENTS_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Fixture);
}

// The body a sender posts for one fixture: the email read in, the fixture's notes left out.
export function fixtureBody(fixture: Fixture): HcpEvent {
  const { file, note: _note, ...rest } = fixture;
  const body = file ? { ...rest, raw_email: readFileSync(path.join(EVENTS_DIR, path.basename(file)), "utf8") } : rest;
  return EventSchema.parse(body);
}

export function fixtureById(eventId: string): HcpEvent {
  const fixture = fixtureEvents().find((item) => item.event_id === eventId);
  if (!fixture) throw new Error(`No fixture event ${eventId} in data/hcp/events/events.jsonl.`);
  return fixtureBody(fixture);
}
