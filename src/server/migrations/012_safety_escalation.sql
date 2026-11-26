-- An adverse event has 24 hours. An item still waiting past its due_at is escalated by the clock
-- job (src/server/safety/clock.ts): its status becomes 'escalated', escalated_at says when, and a
-- second notification row is written. An escalated item stays in the inbox and is decided like a
-- waiting one. Only adverse events are ever escalated; other review kinds are untouched.
ALTER TABLE review_items DROP CONSTRAINT review_items_status_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_status_check
  CHECK (status IN ('waiting', 'escalated', 'approved', 'rejected', 'filed', 'dismissed'));
ALTER TABLE review_items ADD COLUMN escalated_at timestamptz;
CREATE INDEX review_items_open_ae ON review_items (due_at) WHERE kind = 'adverse_event' AND status = 'waiting';

-- One row per message sent to the safety team about an item: 'raised' when the item is made,
-- 'escalated' when its clock runs out. The pair is unique, so a repeated run adds nothing.
CREATE TABLE safety_notifications (
  id bigserial PRIMARY KEY,
  item_id text NOT NULL REFERENCES review_items (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('raised', 'escalated')),
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, kind)
);
