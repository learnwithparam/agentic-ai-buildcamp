import express, { Router } from "express";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { duplicateReport, EventSchema } from "./events";
import type { EventQueue, EventStore } from "./store";

// Lesson 16. Where events come in: one URL per company, signed the Standard Webhooks way
// (standardwebhooks.com). Each company has its own signing secret, so a valid signature says
// which company sent the event; nothing in the body can say otherwise.
//
//   202 accepted   the first delivery of this id: stored and queued, handled by the worker
//   200 duplicate  the same id again: counted, nothing runs again
//   401            no valid signature for this company (wrong secret, changed body, too old)
//   422            the body names another company, or is not an event this desk knows
//
// The id the sender signs (the webhook-id header) must be the event's own id, so a retry with
// the same id is the same event.

export function createEventRouter(options: { secrets: Record<string, string>; store: EventStore; queue: EventQueue }) {
  const router = Router();
  const verifiers = Object.fromEntries(Object.entries(options.secrets).filter(([, secret]) => secret).map(([tenant, secret]) => [tenant, new Webhook(secret)]));

  // The signature covers the exact bytes sent, so the body is read raw and parsed only after.
  router.post("/events/:tenant", express.raw({ type: "application/json", limit: "512kb" }), async (request, response, next) => {
    const sender = request.params.tenant;
    const verifier = verifiers[sender];
    if (!verifier) {
      response.status(404).json({ error: "No events are taken for that company here." });
      return;
    }
    let body: unknown;
    try {
      body = verifier.verify(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "", {
        "webhook-id": String(request.headers["webhook-id"] ?? ""),
        "webhook-timestamp": String(request.headers["webhook-timestamp"] ?? ""),
        "webhook-signature": String(request.headers["webhook-signature"] ?? "")
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        response.status(401).json({ error: "The signature is not valid for this company." });
        return;
      }
      return next(error);
    }
    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) {
      response.status(422).json({ error: "This is not an event the desk knows.", issues: parsed.error.issues.map((issue) => issue.path.join(".")) });
      return;
    }
    const event = parsed.data;
    if (event.event_id !== request.headers["webhook-id"]) {
      response.status(422).json({ error: "The webhook-id header must be the event's own id." });
      return;
    }
    // Refused at the door, before it is stored: the reply names nothing about the other company.
    if (event.tenant_id !== sender) {
      response.status(422).json({ report: `INSUFFICIENT_CONTEXT: event ${event.event_id} is not about your company, so it was not taken.` });
      return;
    }
    try {
      const { first, row } = await options.store.receive(sender, event, options.queue);
      if (first) response.status(202).json({ eventId: row.eventId, status: "accepted" });
      else response.status(200).json({ eventId: row.eventId, status: "duplicate", deliveries: row.deliveries, report: duplicateReport(row.eventId, row.deliveries) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

// The signing secrets, one per company, from .env (npm run events:setup writes them).
// EVENT_SECRET_PHARMA_A is pharma_a's.
export function eventSecrets(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([name, value]) => name.startsWith("EVENT_SECRET_") && value)
      .map(([name, value]) => [name.slice("EVENT_SECRET_".length).toLowerCase(), value as string])
  );
}
