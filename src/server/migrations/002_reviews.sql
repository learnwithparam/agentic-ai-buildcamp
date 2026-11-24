-- Lesson 13. A thread belongs to the doctor who started it. Kept here, not in memory, so a
-- restart does not turn every open conversation into "No such thread".
CREATE TABLE threads (
  thread_id text PRIMARY KEY,
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_owner_id ON threads (owner_id);

-- One row per item a human must decide: a draft for a medical reviewer, or an adverse event for
-- a safety reviewer. The id comes from the message it is about, so a node that runs again on
-- resume writes the same row, not a second one.
CREATE TABLE review_items (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('draft', 'adverse_event')),
  thread_id text NOT NULL REFERENCES threads (thread_id),
  tenant_id text NOT NULL,
  trace_id text,
  question text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved', 'rejected', 'filed', 'dismissed')),
  decided_by text,
  decided_at timestamptz,
  note text
);
CREATE INDEX review_items_waiting ON review_items (tenant_id, due_at) WHERE status = 'waiting';
CREATE INDEX review_items_thread_id ON review_items (thread_id);
