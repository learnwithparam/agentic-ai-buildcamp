import { ClientWriteRequestOnDuplicateWrites, type OpenFgaClient } from "@openfga/sdk";
import type pg from "pg";
import type { ReviewInbox, ReviewSubmission } from "./graph";
import { fga, reviewerTuples } from "./permissions";
import { REVIEW_HOURS, SAFETY_HOURS } from "./tiers";
import type { Identity } from "./users";

// Lesson 13. The threads and the reviewer inbox, in the app's Postgres. A restart loses
// neither: who owns a thread, and every item still waiting for a human, are rows.
//
// Who may decide an item is OpenFGA's answer (infra/openfga/model.fga): each item's company is
// stored there when the item is made, and the reviewer's role comes from their token.

export type ReviewKind = ReviewSubmission["kind"];
export type ReviewStatus = "waiting" | "approved" | "rejected" | "filed" | "dismissed";

export type ReviewItem = {
  id: string;
  kind: ReviewKind;
  threadId: string;
  tenantId: string;
  traceId: string | null;
  question: string;
  body: string;
  createdAt: string;
  dueAt: string;
  status: ReviewStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
};

// What a reviewer may answer, per kind. A draft is approved or rejected; an adverse event is
// filed with the safety database or dismissed as not one.
export const DECISIONS: Record<ReviewKind, ReviewStatus[]> = {
  draft: ["approved", "rejected"],
  adverse_event: ["filed", "dismissed"]
};

const HOURS: Record<ReviewKind, number> = { draft: REVIEW_HOURS, adverse_event: SAFETY_HOURS };

type Row = {
  id: string;
  kind: ReviewKind;
  thread_id: string;
  tenant_id: string;
  trace_id: string | null;
  question: string;
  body: string;
  created_at: Date;
  due_at: Date;
  status: ReviewStatus;
  decided_by: string | null;
  decided_at: Date | null;
  note: string | null;
};

const toItem = (row: Row): ReviewItem => ({
  id: row.id,
  kind: row.kind,
  threadId: row.thread_id,
  tenantId: row.tenant_id,
  traceId: row.trace_id,
  question: row.question,
  body: row.body,
  createdAt: row.created_at.toISOString(),
  dueAt: row.due_at.toISOString(),
  status: row.status,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at?.toISOString() ?? null,
  note: row.note
});


export class ReviewStore implements ReviewInbox {
  constructor(
    private pool: pg.Pool,
    private client: () => OpenFgaClient = fga
  ) {}

  async createThread(threadId: string, owner: Identity) {
    await this.pool.query("INSERT INTO threads (thread_id, owner_id, tenant_id) VALUES ($1, $2, $3)", [threadId, owner.userId, owner.tenantId]);
  }

  async ownsThread(threadId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM threads WHERE thread_id = $1 AND owner_id = $2", [threadId, userId]);
    return Boolean(rowCount);
  }

  async submit(item: ReviewSubmission) {
    // The OpenFGA fact first: a row no reviewer may decide would sit in nobody's inbox.
    await this.client().write(
      { writes: [{ user: `company:${item.tenantId}`, relation: "company", object: `${item.kind}:${item.id}` }] },
      { conflict: { onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore } }
    );
    const { rows } = await this.pool.query<{ due_at: Date }>(
      `INSERT INTO review_items (id, kind, thread_id, tenant_id, trace_id, question, body, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING due_at`,
      [item.id, item.kind, item.threadId, item.tenantId, item.traceId ?? null, item.question, item.body, HOURS[item.kind]]
    );
    return { dueAt: rows[0].due_at };
  }

  // A reviewer's inbox: every waiting item OpenFGA says they may decide, the soonest due first.
  async waitingFor(reviewer: Identity): Promise<ReviewItem[]> {
    const ids = await this.decidable(reviewer);
    if (!ids.length) return [];
    const { rows } = await this.pool.query<Row>("SELECT * FROM review_items WHERE id = ANY($1) AND status = 'waiting' ORDER BY due_at", [ids]);
    return rows.map(toItem);
  }

  // A doctor's view: what happened to the items their own threads raised.
  async raisedBy(doctor: Identity): Promise<ReviewItem[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT r.* FROM review_items r JOIN threads t ON t.thread_id = r.thread_id
       WHERE t.owner_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [doctor.userId]
    );
    return rows.map(toItem);
  }

  async get(id: string): Promise<ReviewItem | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM review_items WHERE id = $1", [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async canDecide(reviewer: Identity, item: ReviewItem): Promise<boolean> {
    if (!reviewer.roles.length) return false;
    const { allowed } = await this.client().check({
      user: `user:${reviewer.userId}`,
      relation: "can_decide",
      object: `${item.kind}:${item.id}`,
      contextualTuples: reviewerTuples(reviewer)
    });
    return Boolean(allowed);
  }

  // Records the decision once. A second reviewer deciding the same item gets null, not a rewrite.
  async decide(id: string, reviewer: Identity, status: ReviewStatus, note: string): Promise<ReviewItem | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE review_items SET status = $2, decided_by = $3, decided_at = now(), note = $4
       WHERE id = $1 AND status = 'waiting' RETURNING *`,
      [id, status, reviewer.userId, note || null]
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  // Puts a decided item back in the inbox, for when its thread could not continue.
  async reopen(id: string) {
    await this.pool.query("UPDATE review_items SET status = 'waiting', decided_by = NULL, decided_at = NULL, note = NULL WHERE id = $1", [id]);
  }

  private async decidable(reviewer: Identity): Promise<string[]> {
    if (!reviewer.roles.length) return [];
    const kinds: ReviewKind[] = ["draft", "adverse_event"];
    const lists = await Promise.all(
      kinds.map((kind) =>
        this.client().listObjects({
          user: `user:${reviewer.userId}`,
          relation: "can_decide",
          type: kind,
          contextualTuples: reviewerTuples(reviewer)
        })
      )
    );
    return lists.flatMap(({ objects }) => objects.map((object) => object.slice(object.indexOf(":") + 1)));
  }
}
