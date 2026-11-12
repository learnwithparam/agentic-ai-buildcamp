// The job table. Saved in SQLite so a restarted employee picks up where it stopped.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Job = {
  job_id: string;
  run_id: string;
  tenant: string;
  trigger: any;
  input: any;
  status: "working" | "waiting_for_human" | "done" | "declined" | "stopped" | "failed";
  reason: string | null;
  column: string | null;
  steps: Record<string, any>;
  spend_usd: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
};
export type Approval = {
  approval_id: string;
  job_id: string;
  action: string;
  amount: number;
  summary: string;
  approver_role: string;
  status: string;
  decided_by: string | null;
};

export function openStore(dir: string | null) {
  let path = ":memory:";
  if (dir) {
    mkdirSync(dir, { recursive: true });
    path = join(dir, "jobs.sqlite");
  }
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT, trigger TEXT, input TEXT, status TEXT, reason TEXT, "column" TEXT, steps TEXT, spend_usd REAL, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, job_id TEXT, action TEXT, amount REAL, summary TEXT, approver_role TEXT, status TEXT, decided_by TEXT);`);
  const parse = (r: any): Job | null =>
    r
      ? {
          ...r,
          trigger: JSON.parse(r.trigger),
          input: JSON.parse(r.input),
          steps: JSON.parse(r.steps),
        }
      : null;
  return {
    get: (id: string) => parse(db.query("SELECT * FROM jobs WHERE job_id = ?").get(id)),
    all: () =>
      (db.query("SELECT * FROM jobs ORDER BY created_at").all() as any[]).map((r) => parse(r)!),
    insert(j: Job) {
      db.query(`INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        j.job_id,
        j.run_id,
        j.tenant,
        JSON.stringify(j.trigger),
        JSON.stringify(j.input),
        j.status,
        j.reason,
        j.column,
        JSON.stringify(j.steps),
        j.spend_usd,
        j.summary,
        j.created_at,
        j.updated_at,
      );
    },
    update(id: string, patch: Partial<Job>) {
      const j = { ...this.get(id)!, ...patch, updated_at: new Date().toISOString() };
      db.query(
        `UPDATE jobs SET status=?, reason=?, "column"=?, steps=?, spend_usd=?, summary=? WHERE job_id=?`,
      ).run(j.status, j.reason, j.column, JSON.stringify(j.steps), j.spend_usd, j.summary, id);
      return j;
    },
    approvals: (status?: string) =>
      (status
        ? db.query("SELECT * FROM approvals WHERE status = ?").all(status)
        : db.query("SELECT * FROM approvals").all()) as Approval[],
    approval: (id: string) =>
      db.query("SELECT * FROM approvals WHERE approval_id = ?").get(id) as Approval | null,
    addApproval(a: Approval) {
      db.query("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)").run(
        a.approval_id,
        a.job_id,
        a.action,
        a.amount,
        a.summary,
        a.approver_role,
        a.status,
        a.decided_by,
      );
    },
    decide(id: string, status: string, by: string) {
      db.query("UPDATE approvals SET status=?, decided_by=? WHERE approval_id=?").run(
        status,
        by,
        id,
      );
    },
  };
}
