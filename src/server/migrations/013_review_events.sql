-- The audit trail for review decisions (21 CFR 11.10(e): secure, time-stamped, computer-made, and
-- a change must not hide what was there before). review_items stays the read model, the current
-- state of each item. This table keeps every change to it, one row each, and Postgres refuses to
-- change or remove a row once written. A database owner can still drop the trigger, so the
-- table is also a reason to keep the app's own login without that right.
CREATE TABLE review_events (
  id bigserial PRIMARY KEY,
  item_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_events_item_id ON review_events (item_id, id);

CREATE FUNCTION review_events_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER review_events_no_change BEFORE UPDATE OR DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION review_events_refuse();
CREATE TRIGGER review_events_no_truncate BEFORE TRUNCATE ON review_events
  FOR EACH STATEMENT EXECUTE FUNCTION review_events_refuse();
