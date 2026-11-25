-- Lesson 16. The event inbox: every event a sender delivered, once per id. A queue sends at least
-- once, so a second delivery of the same id adds to deliveries and starts nothing.
-- The job that handles an event is queued in the same transaction as its first row (pg-boss, in
-- its own schema), so an event is never stored without its job, nor queued without its row.
CREATE TABLE events (
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  deliveries integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'handled', 'failed')),
  outcome text,
  report text,
  item_ids text[] NOT NULL DEFAULT '{}',
  trace_id text,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  last_delivered_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX events_tenant_received ON events (tenant_id, received_at DESC);
