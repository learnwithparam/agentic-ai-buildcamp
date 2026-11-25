import { useCallback, useEffect, useState } from "react";
import { loadEvents, type EventView } from "../chat/api";
import { formatDue } from "../inbox/format";

// Lesson 16. The event inbox. Events come in from outside a chat: a label comes into force, an
// email reaches the medical information inbox, a draft is uploaded, the call center logs a call.
// Each is stored once however often it is delivered, and handled once by a worker. The page shows
// what each event started; anything that needs a person waits in the review inbox.

const KIND: Record<EventView["type"], string> = {
  "label.in_force": "A label came into force",
  "email.received": "An email arrived",
  "draft.uploaded": "A draft was uploaded",
  "call.logged": "The call center logged a call"
};

const STATUS: Record<EventView["status"], { label: string; tone: string }> = {
  queued: { label: "Waiting for the worker", tone: "status-wait" },
  handled: { label: "Handled", tone: "status-pass" },
  failed: { label: "Failed after every retry", tone: "status-fail" }
};

const deliveries = (count: number) => (count === 1 ? "Delivered once" : `Delivered ${count} times, handled once`);

function EventCard({ event }: { event: EventView }) {
  const status = event.outcome === "INSUFFICIENT_CONTEXT" ? { label: "Not enough to act on", tone: "status-wait" } : STATUS[event.status];
  return (
    <article className="card inbox-item" aria-label={`Event ${event.eventId}`}>
      <div className="card-head">
        <span>
          <span className="source-id">{event.eventId}</span> {KIND[event.type]}
        </span>
        <span className={`status ${status.tone}`}>{status.label}</span>
      </div>
      <div className="card-body">
        <p className="check-meta">
          Happened {formatDue(event.occurredAt)}. {deliveries(event.deliveries)}.
          {event.handledAt ? ` Handled ${formatDue(event.handledAt)}.` : ""}
        </p>
        {event.report && <div className="approval-draft">{event.report}</div>}
        {event.error && <p className="inbox-error">{event.error}</p>}
        {(event.itemIds.length > 0 || event.report?.includes("REVIEW_REQUIRED") || event.report?.includes("PV_ESCALATION")) && (
          <p className="approval-note">
            What this event started waits in the <a href="/inbox">inbox</a> for a person to decide. Nothing reaches a doctor before that.
          </p>
        )}
      </div>
    </article>
  );
}

export function Events() {
  const [events, setEvents] = useState<EventView[] | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    loadEvents()
      .then(({ events: rows }) => {
        setEvents(rows);
        setError("");
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);

  useEffect(refresh, [refresh]);
  // While the worker still holds an event, look again every few seconds.
  const waiting = events?.some((event) => event.status === "queued") ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  return (
    <main className="inbox">
      <h1>Events</h1>
      <p className="inbox-lead">
        What happened outside a chat, and what each event started. An event delivered twice is still handled once, and an event about another company is never taken.
      </p>
      <div className="approval-actions">
        <button type="button" className="button" onClick={refresh}>
          Refresh
        </button>
      </div>
      {error && <p className="inbox-error">{error}</p>}
      {!events ? (
        <p className="inbox-empty" aria-busy="true">
          Reading the events...
        </p>
      ) : events.length === 0 ? (
        <p className="inbox-empty">No events yet. Send one with npm run events:send -- EVT-01.</p>
      ) : (
        events.map((event) => <EventCard key={event.eventId} event={event} />)
      )}
    </main>
  );
}
