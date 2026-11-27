// The audit trail's SQL. The row a decision writes is made by the same statement that changes
// review_items, so a decision with no event, or an event with no decision, cannot happen.

// The fields of a review item that a decision changes, as the trail stores them.
const stateOf = (alias: string) =>
  `jsonb_build_object('status', ${alias}.status, 'decided_by', ${alias}.decided_by, 'decided_at', ${alias}.decided_at, 'note', ${alias}.note, 'escalated_at', ${alias}.escalated_at)`;

// Parameters: $1 item id, $2 new status, $3 reviewer id, $4 note. Only an open item (waiting, or
// escalated by the safety clock) changes.
export const DECIDE_SQL = `
  WITH prior AS (SELECT * FROM review_items WHERE id = $1 AND status IN ('waiting', 'escalated') FOR UPDATE),
  changed AS (
    UPDATE review_items r SET status = $2, decided_by = $3, decided_at = now(), note = $4
    FROM prior WHERE r.id = prior.id RETURNING r.*
  ),
  event AS (
    INSERT INTO review_events (item_id, actor, action, before, after)
    SELECT changed.id, $3, $2, ${stateOf("prior")}, ${stateOf("changed")} FROM changed JOIN prior ON prior.id = changed.id
  )
  SELECT * FROM changed`;

// Parameters: $1 item id. Puts a decided item back to waiting, as the system, and says so.
export const REOPEN_SQL = `
  WITH prior AS (SELECT * FROM review_items WHERE id = $1 AND status NOT IN ('waiting', 'escalated') FOR UPDATE),
  changed AS (
    UPDATE review_items r SET status = 'waiting', escalated_at = NULL, decided_by = NULL, decided_at = NULL, note = NULL
    FROM prior WHERE r.id = prior.id RETURNING r.*
  )
  INSERT INTO review_events (item_id, actor, action, before, after)
  SELECT changed.id, 'system', 'reopened', ${stateOf("prior")}, ${stateOf("changed")} FROM changed JOIN prior ON prior.id = changed.id`;


// Parameters: $1 now. The 24 hour safety clock (src/server/safety/clock.ts): every adverse event
// still waiting after its due time becomes escalated, and the trail says the system did it.
export const ESCALATE_SQL = `
  WITH prior AS (
    SELECT * FROM review_items WHERE kind = 'adverse_event' AND status = 'waiting' AND due_at < $1 FOR UPDATE
  ),
  changed AS (
    UPDATE review_items r SET status = 'escalated', escalated_at = $1
    FROM prior WHERE r.id = prior.id RETURNING r.*
  ),
  event AS (
    INSERT INTO review_events (item_id, actor, action, before, after)
    SELECT changed.id, 'system', 'escalated', ${stateOf("prior")}, ${stateOf("changed")} FROM changed JOIN prior ON prior.id = changed.id
  )
  SELECT id, tenant_id, due_at, escalated_at FROM changed`;
