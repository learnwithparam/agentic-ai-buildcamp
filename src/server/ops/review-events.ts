// The audit trail's SQL. The row a decision writes is made by the same statement that changes
// review_items, so a decision with no event, or an event with no decision, cannot happen.

// The fields of a review item that a decision changes, as the trail stores them.
const stateOf = (alias: string) =>
  `jsonb_build_object('status', ${alias}.status, 'decided_by', ${alias}.decided_by, 'decided_at', ${alias}.decided_at, 'note', ${alias}.note)`;

// Parameters: $1 item id, $2 new status, $3 reviewer id, $4 note. Only a waiting item changes.
export const DECIDE_SQL = `
  WITH prior AS (SELECT * FROM review_items WHERE id = $1 AND status = 'waiting' FOR UPDATE),
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
  WITH prior AS (SELECT * FROM review_items WHERE id = $1 AND status <> 'waiting' FOR UPDATE),
  changed AS (
    UPDATE review_items r SET status = 'waiting', decided_by = NULL, decided_at = NULL, note = NULL
    FROM prior WHERE r.id = prior.id RETURNING r.*
  )
  INSERT INTO review_events (item_id, actor, action, before, after)
  SELECT changed.id, 'system', 'reopened', ${stateOf("prior")}, ${stateOf("changed")} FROM changed JOIN prior ON prior.id = changed.id`;
