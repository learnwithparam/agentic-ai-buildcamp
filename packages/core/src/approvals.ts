// Approvals and memory live in Postgres, so a restart loses nothing.
// A waiting approval is a row. A person who may approve it decides, and only then is a reply sent.
import { personNamed } from "../../../data/catalog/people";
import { inTransaction, rows } from "./db";

export type Status = "pending" | "approved" | "rejected";
export type Approval = {
  id: number;
  requester: string;
  topic: string;
  question: string;
  status: Status;
  decided_by: string | null;
};

const TOPIC = "adverse-events";

const TABLES = `
  CREATE TABLE IF NOT EXISTS approvals (id serial PRIMARY KEY, requester text, topic text,
    question text, status text DEFAULT 'pending', decided_by text);
  CREATE TABLE IF NOT EXISTS outbox (approval_id int, body text, sent_by text);
  CREATE TABLE IF NOT EXISTS memories (tenant text, person text, note text,
    created timestamptz DEFAULT clock_timestamp())`;

export async function setupTables(): Promise<void> {
  await rows(TABLES);
}

export async function resetApprovals(): Promise<void> {
  await rows("DROP TABLE IF EXISTS approvals, outbox, memories");
  await setupTables();
}

// #region step:approvals-memory
export async function requestApproval(requester: string, question: string): Promise<number> {
  await setupTables();
  const [row] = await rows<{ id: number }>(
    "INSERT INTO approvals (requester, topic, question) VALUES ($1, $2, $3) RETURNING id",
    [requester, TOPIC, question],
  );
  return row.id;
}

export async function pendingFor(approver: string): Promise<Approval[]> {
  await setupTables();
  return rows<Approval>(
    `SELECT * FROM approvals a WHERE a.status = 'pending' AND EXISTS (
       SELECT 1 FROM grants g
       WHERE g.person = $1 AND g.relation = 'approves' AND g.object = a.topic)
     ORDER BY a.id`,
    [approver],
  );
}

// One decision, once. Only a person who holds the approves grant may make it.
export async function decide(id: number, approver: string, approved: boolean): Promise<Status> {
  return inTransaction(async (run) => {
    const found = await run("SELECT * FROM approvals WHERE id = $1 AND status = 'pending'", [id]);
    if (found.rows.length === 0) throw new Error(`Approval ${id} is not waiting.`);
    const approval = found.rows[0] as Approval;
    const grant =
      "SELECT 1 FROM grants WHERE person = $1 AND relation = 'approves' AND object = $2";
    const allowed = await run(grant, [approver, approval.topic]);
    if (allowed.rows.length === 0) throw new Error(`${approver} may not decide ${approval.topic}.`);
    const status = approved ? "approved" : "rejected";
    await run("UPDATE approvals SET status = $2, decided_by = $3 WHERE id = $1", [
      id,
      status,
      approver,
    ]);
    if (approved) {
      const body = `Reply sent for: ${approval.question}`;
      await run("INSERT INTO outbox VALUES ($1, $2, $3)", [id, body, approver]);
    }
    return status;
  });
}

// Notes stay with one person.
export async function remember(person: string, note: string): Promise<void> {
  const owner = personNamed(person);
  await setupTables();
  await rows("INSERT INTO memories (tenant, person, note) VALUES ($1, $2, $3)", [
    owner.tenant,
    owner.name,
    note,
  ]);
}

export async function recall(person: string): Promise<string[]> {
  const owner = personNamed(person);
  await setupTables();
  const found = await rows<{ note: string }>(
    "SELECT note FROM memories WHERE tenant = $1 AND person = $2 ORDER BY created",
    [owner.tenant, owner.name],
  );
  return found.map((item) => item.note);
}
// #stub
//~ // TODO(approvals-memory): store approvals, let an approver decide once, keep notes
//~ export async function requestApproval(_requester: string, _question: string): Promise<number> {
//~   return 0;
//~ }
//~
//~ export async function pendingFor(_approver: string): Promise<Approval[]> {
//~   return [];
//~ }
//~
//~ export async function decide(_id: number, _who: string, _yes: boolean): Promise<Status> {
//~   return "pending";
//~ }
//~
//~ export async function remember(_person: string, _note: string): Promise<void> {}
//~
//~ export async function recall(_person: string): Promise<string[]> {
//~   return [];
//~ }
// #endregion
