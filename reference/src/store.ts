// The job table. Saved in SQLite so a restarted employee picks up where it stopped.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "./audit";

// What started the job: a person, an event or another agent.
export type JobTrigger = { kind: string; by?: string; [detail: string]: unknown };
export type JobInput = { invoice_id: string; [detail: string]: unknown };

// The model's draft decision, as it replied. The checker compares it with the evidence.
export type Draft = {
  action: "pay" | "dispute";
  amount_usd: number;
  reason_code?: string | null;
  note: string;
  approved_by?: string | null;
};

// Each finished step is saved, so a resumed job does not do it again.
export type JobSteps = {
  evidence?: Evidence;
  draft?: Draft;
  approval?: { by: string; at?: string; from?: string };
  cost_unknown?: boolean;
  [step: string]: unknown;
};

export type Job = {
  job_id: string;
  run_id: string;
  tenant: string;
  trigger: JobTrigger;
  input: JobInput;
  status: "working" | "waiting_for_human" | "done" | "declined" | "stopped" | "failed";
  reason: string | null;
  column: string | null;
  steps: JobSteps;
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

// A job as SQLite holds it: trigger, input and steps are JSON text.
type JobRow = Omit<Job, "trigger" | "input" | "steps"> & {
  trigger: string;
  input: string;
  steps: string;
};

const CREATE_TABLES = `PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT,
      trigger TEXT, input TEXT, status TEXT, reason TEXT, "column" TEXT, steps TEXT,
      spend_usd REAL, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, job_id TEXT,
      action TEXT, amount REAL, summary TEXT, approver_role TEXT, status TEXT, decided_by TEXT);`;

function openDatabase(dir: string | null): Database {
  let path = ":memory:";
  if (dir) {
    mkdirSync(dir, { recursive: true });
    path = join(dir, "jobs.sqlite");
  }
  const db = new Database(path, { create: true });
  db.exec(CREATE_TABLES);
  return db;
}

function jobFromRow(row: JobRow): Job {
  return {
    ...row,
    trigger: JSON.parse(row.trigger),
    input: JSON.parse(row.input),
    steps: JSON.parse(row.steps),
  };
}

function getJob(db: Database, jobId: string): Job | null {
  const row = db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null;
  if (!row) return null;
  return jobFromRow(row);
}

function allJobs(db: Database): Job[] {
  const rows = db.query("SELECT * FROM jobs ORDER BY created_at").all() as JobRow[];
  return rows.map(jobFromRow);
}

function insertJob(db: Database, job: Job) {
  db.query("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    job.job_id,
    job.run_id,
    job.tenant,
    JSON.stringify(job.trigger),
    JSON.stringify(job.input),
    job.status,
    job.reason,
    job.column,
    JSON.stringify(job.steps),
    job.spend_usd,
    job.summary,
    job.created_at,
    job.updated_at,
  );
}

function updateJob(db: Database, jobId: string, patch: Partial<Job>): Job {
  const updatedAt = new Date().toISOString();
  const job = { ...getJob(db, jobId), ...patch, updated_at: updatedAt } as Job;
  const sql = `UPDATE jobs SET status=?, reason=?, "column"=?, steps=?, spend_usd=?, summary=?
    WHERE job_id=?`;
  const steps = JSON.stringify(job.steps);
  db.query(sql).run(job.status, job.reason, job.column, steps, job.spend_usd, job.summary, jobId);
  return job;
}

function listApprovals(db: Database, status?: string): Approval[] {
  if (status) return db.query("SELECT * FROM approvals WHERE status = ?").all(status) as Approval[];
  return db.query("SELECT * FROM approvals").all() as Approval[];
}

function insertApproval(db: Database, approval: Approval) {
  db.query("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)").run(
    approval.approval_id,
    approval.job_id,
    approval.action,
    approval.amount,
    approval.summary,
    approval.approver_role,
    approval.status,
    approval.decided_by,
  );
}

export function openStore(dir: string | null) {
  const db = openDatabase(dir);
  return {
    get: (jobId: string) => getJob(db, jobId),
    all: () => allJobs(db),
    insert: (job: Job) => insertJob(db, job),
    update: (jobId: string, patch: Partial<Job>) => updateJob(db, jobId, patch),
    approvals: (status?: string) => listApprovals(db, status),
    approval: (approvalId: string) =>
      db.query("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as Approval | null,
    addApproval: (approval: Approval) => insertApproval(db, approval),
    decide(approvalId: string, status: string, decidedBy: string) {
      const sql = "UPDATE approvals SET status=?, decided_by=? WHERE approval_id=?";
      db.query(sql).run(status, decidedBy, approvalId);
    },
  };
}
