import type pg from "pg";

// The 24 hour safety clock. Every adverse event item has a due_at (reviews.ts sets it from
// SAFETY_HOURS). When one is still waiting after it, this job escalates it: the item's status
// becomes 'escalated', escalated_at records when, and a second safety_notifications row
// ('escalated', after the 'raised' row made with the item) goes to the safety team.
//
// Only adverse events are touched. An escalated item stays in the inbox and a reviewer still
// decides it. Running the job twice escalates nothing twice: it looks only at 'waiting' items,
// and the notification pair (item, kind) is unique.

export const CLOCK_INTERVAL_MS = 60_000;

export type Escalated = { id: string; tenantId: string; dueAt: string; escalatedAt: string };

export async function escalateOverdue(pool: pg.Pool, now: Date = new Date()): Promise<Escalated[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; tenant_id: string; due_at: Date; escalated_at: Date }>(
      `UPDATE review_items SET status = 'escalated', escalated_at = $1
       WHERE kind = 'adverse_event' AND status = 'waiting' AND due_at < $1
       RETURNING id, tenant_id, due_at, escalated_at`,
      [now]
    );
    if (rows.length) {
      await client.query(
        `INSERT INTO safety_notifications (item_id, kind, tenant_id, created_at)
         SELECT id, 'escalated', tenant_id, $2 FROM review_items WHERE id = ANY($1)
         ON CONFLICT (item_id, kind) DO NOTHING`,
        [rows.map((row) => row.id), now]
      );
    }
    await client.query("COMMIT");
    return rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, dueAt: row.due_at.toISOString(), escalatedAt: row.escalated_at.toISOString() }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Runs the job on a timer inside the web server. Two servers running it is safe: the UPDATE
// takes each row once. A failed run is logged and the next tick tries again.
export function startSafetyClock(pool: pg.Pool, intervalMs: number = CLOCK_INTERVAL_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await escalateOverdue(pool);
      if (done.length) console.warn(`Safety clock: escalated ${done.length} overdue adverse event(s): ${done.map((item) => item.id).join(", ")}`);
    } catch (error) {
      console.warn(`Safety clock failed, will retry: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
