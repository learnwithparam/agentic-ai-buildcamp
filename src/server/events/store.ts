import type pg from "pg";
import { PgBoss } from "pg-boss";
import { scrubPhi } from "../phi";
import type { EventHandler } from "./handlers";
import type { EventResult, HcpEvent } from "./events";

// Lesson 16. The event inbox (the "inbox pattern"): a delivery is stored before anything runs,
// keyed by the sender's company and the event id. The first delivery of an id queues one job, in
// the same transaction; every later delivery only counts. The worker skips an event already
// handled, so a job that runs twice (pg-boss also delivers at least once) does nothing twice.

export type EventStatus = "queued" | "handled" | "failed";
export type EventRow = {
  tenantId: string;
  eventId: string;
  type: HcpEvent["type"];
  payload: HcpEvent;
  deliveries: number;
  status: EventStatus;
  result: EventResult | null;
  error: string | null;
  receivedAt: string;
  handledAt: string | null;
};
export type EventJob = { tenantId: string; eventId: string };

// The one thing a store needs from a queue: send a job, inside the store's transaction when it has one.
export type SqlRunner = { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
export interface EventQueue {
  send(job: EventJob, db?: SqlRunner): Promise<void>;
}

export interface EventStore {
  // Stores one delivery. first is true only for the first delivery of this id from this sender.
  receive(sender: string, event: HcpEvent, queue: EventQueue): Promise<{ first: boolean; row: EventRow }>;
  get(sender: string, eventId: string): Promise<EventRow | null>;
  list(sender: string, limit?: number): Promise<EventRow[]>;
  complete(sender: string, eventId: string, result: EventResult): Promise<void>;
  fail(sender: string, eventId: string, error: string): Promise<void>;
}

// A handled email keeps only its scrubbed text: the raw message (with any record number in it)
// is needed to handle the event, and not after.
function afterHandling(payload: HcpEvent): HcpEvent {
  return payload.type === "email.received" ? { ...payload, raw_email: scrubPhi(payload.raw_email).text } : payload;
}

// One job: read the stored event, skip it if it is already handled, otherwise handle it and
// store the result. A failure is thrown, so the queue retries it.
export async function handleJob(store: EventStore, handle: EventHandler, job: EventJob) {
  const row = await store.get(job.tenantId, job.eventId);
  if (!row || row.status === "handled") return;
  const result = await handle(row.payload, job.tenantId);
  await store.complete(job.tenantId, job.eventId, result);
}

type Row = {
  tenant_id: string;
  event_id: string;
  type: HcpEvent["type"];
  payload: HcpEvent;
  deliveries: number;
  status: EventStatus;
  outcome: EventResult["outcome"] | null;
  report: string | null;
  item_ids: string[];
  trace_id: string | null;
  error: string | null;
  received_at: Date;
  handled_at: Date | null;
};

const toRow = (row: Row): EventRow => ({
  tenantId: row.tenant_id,
  eventId: row.event_id,
  type: row.type,
  payload: row.payload,
  deliveries: row.deliveries,
  status: row.status,
  result: row.outcome ? { outcome: row.outcome, report: row.report ?? "", itemIds: row.item_ids, traceId: row.trace_id ?? undefined } : null,
  error: row.error,
  receivedAt: row.received_at.toISOString(),
  handledAt: row.handled_at?.toISOString() ?? null
});

export class PostgresEventStore implements EventStore {
  constructor(private pool: pg.Pool) {}

  async receive(sender: string, event: HcpEvent, queue: EventQueue) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // xmax is 0 only on a row this statement inserted, so it tells a first delivery from a repeat.
      const { rows } = await client.query<Row & { first: boolean }>(
        `INSERT INTO events (tenant_id, event_id, type, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, event_id) DO UPDATE SET deliveries = events.deliveries + 1, last_delivered_at = now()
         RETURNING *, (xmax = 0) AS first`,
        [sender, event.event_id, event.type, event]
      );
      const first = rows[0].first;
      if (first) await queue.send({ tenantId: sender, eventId: event.event_id }, { executeSql: (text, values) => client.query(text, values) });
      await client.query("COMMIT");
      return { first, row: toRow(rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(sender: string, eventId: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM events WHERE tenant_id = $1 AND event_id = $2", [sender, eventId]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(sender: string, limit = 50) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM events WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT $2", [sender, limit]);
    return rows.map(toRow);
  }

  async complete(sender: string, eventId: string, result: EventResult) {
    const row = await this.get(sender, eventId);
    if (!row) return;
    await this.pool.query(
      `UPDATE events SET status = 'handled', outcome = $3, report = $4, item_ids = $5, trace_id = $6, payload = $7, error = NULL, handled_at = now()
       WHERE tenant_id = $1 AND event_id = $2 AND status <> 'handled'`,
      [sender, eventId, result.outcome, result.report, result.itemIds, result.traceId ?? null, afterHandling(row.payload)]
    );
  }

  async fail(sender: string, eventId: string, error: string) {
    await this.pool.query("UPDATE events SET status = 'failed', error = $3 WHERE tenant_id = $1 AND event_id = $2 AND status <> 'handled'", [sender, eventId, error]);
  }
}

// The same inbox in memory, for scripts (the dataset run), whose events are thrown away.
// src/server/events/events.test.ts runs one suite against both stores.
export class MemoryEventStore implements EventStore {
  private rows = new Map<string, EventRow>();
  private key = (sender: string, eventId: string) => `${sender}\u0000${eventId}`;

  async receive(sender: string, event: HcpEvent, queue: EventQueue) {
    const existing = this.rows.get(this.key(sender, event.event_id));
    if (existing) {
      existing.deliveries += 1;
      return { first: false, row: structuredClone(existing) };
    }
    const row: EventRow = {
      tenantId: sender,
      eventId: event.event_id,
      type: event.type,
      payload: event,
      deliveries: 1,
      status: "queued",
      result: null,
      error: null,
      receivedAt: new Date().toISOString(),
      handledAt: null
    };
    this.rows.set(this.key(sender, event.event_id), row);
    await queue.send({ tenantId: sender, eventId: event.event_id });
    return { first: true, row: structuredClone(row) };
  }

  async get(sender: string, eventId: string) {
    const row = this.rows.get(this.key(sender, eventId));
    return row ? structuredClone(row) : null;
  }

  async list(sender: string, limit = 50) {
    return [...this.rows.values()].filter((row) => row.tenantId === sender).reverse().slice(0, limit).map((row) => structuredClone(row));
  }

  async complete(sender: string, eventId: string, result: EventResult) {
    const row = this.rows.get(this.key(sender, eventId));
    if (!row || row.status === "handled") return;
    Object.assign(row, { status: "handled", result, error: null, payload: afterHandling(row.payload), handledAt: new Date().toISOString() });
  }

  async fail(sender: string, eventId: string, error: string) {
    const row = this.rows.get(this.key(sender, eventId));
    if (row && row.status !== "handled") Object.assign(row, { status: "failed", error });
  }
}

// A queue for scripts: jobs wait in memory until drain() runs them, one at a time.
export class InlineQueue implements EventQueue {
  private waiting: EventJob[] = [];
  async send(job: EventJob) {
    this.waiting.push(job);
  }
  async drain(store: EventStore, handle: EventHandler) {
    for (let job = this.waiting.shift(); job; job = this.waiting.shift()) await handleJob(store, handle, job);
  }
}

// --- The app's queue: pg-boss on the app's own Postgres, in its own schema.
export const EVENT_QUEUE = "hcp-event";
// Where a job goes once its retries are spent. Its worker marks the event failed, so the event
// inbox shows it and a person can look.
export const EVENT_DEAD_LETTER = "hcp-event-failed";

// Three retries, each later than the last (backoff), before the job is dead-lettered. The test
// passes shorter waits, so a failure reaches the dead letter queue in seconds.
const RETRIES = { retryLimit: 3, retryDelay: 5, retryBackoff: true };

export async function startEventQueue(connectionString: string, store: EventStore, handle: EventHandler, retries = RETRIES) {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (error) => console.error("The event queue failed:", error));
  await boss.start();
  await boss.createQueue(EVENT_DEAD_LETTER);
  await boss.createQueue(EVENT_QUEUE, { ...retries, deadLetter: EVENT_DEAD_LETTER });
  // pollingIntervalSeconds: a new event waits at most a second for the worker.
  await boss.work<EventJob>(EVENT_QUEUE, { pollingIntervalSeconds: 1 }, async ([job]) => handleJob(store, handle, job.data));
  await boss.work<EventJob>(EVENT_DEAD_LETTER, { pollingIntervalSeconds: 1 }, async ([job]) => store.fail(job.data.tenantId, job.data.eventId, "The event failed after every retry."));
  const queue: EventQueue = {
    async send(job, db) {
      // db is the store's transaction: the job exists only if the row does.
      await boss.send(EVENT_QUEUE, job, db ? { db } : {});
    }
  };
  // The same pg-boss also runs the nightly sweep (lesson 17), so one stop ends both.
  return { queue, boss, stop: () => boss.stop({ graceful: true, timeout: 30_000 }) };
}
