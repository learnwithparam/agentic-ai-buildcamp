// The job table, saved in SQLite under STATE_DIR.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Trigger = { kind: string; by?: string };
export type JobInput = { invoice_id: string };

export type Job = {
  job_id: string;
  run_id: string;
  tenant: string;
  trigger: Trigger;
  input: JobInput;
  status: string;
  reason: string | null;
  cost_usd: number;
};

// SQLite keeps the trigger and the input as JSON text.
type JobRow = Omit<Job, "trigger" | "input"> & { trigger: string; input: string };

const stateDir = process.env.STATE_DIR ?? ".state";
mkdirSync(stateDir, { recursive: true });
const db = new Database(join(stateDir, "jobs.sqlite"), { create: true });
db.exec(
  "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT, " +
    "trigger TEXT, input TEXT, status TEXT, reason TEXT, cost_usd REAL)",
);

function toJob(row: JobRow): Job {
  return { ...row, trigger: JSON.parse(row.trigger), input: JSON.parse(row.input) };
}

export const jobs = {
  get(jobId: string): Job | null {
    const row = db.query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
    return row ? toJob(row) : null;
  },

  all(): Job[] {
    const rows = db.query<JobRow, []>("SELECT * FROM jobs").all();
    return rows.map(toJob);
  },

  add(newJob: Omit<Job, "status" | "reason" | "cost_usd">): Job {
    db.query("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)").run(
      newJob.job_id,
      newJob.run_id,
      newJob.tenant,
      JSON.stringify(newJob.trigger),
      JSON.stringify(newJob.input),
      "working",
      null,
      0,
    );
    const job = jobs.get(newJob.job_id);
    if (!job) throw new Error(`job ${newJob.job_id} was not saved`);
    return job;
  },

  set(jobId: string, changes: Partial<Pick<Job, "status" | "reason" | "cost_usd">>) {
    const current = jobs.get(jobId);
    // A job that is not in the table has no row to update.
    if (!current) return;
    const job = { ...current, ...changes };
    db.query("UPDATE jobs SET status = ?, reason = ?, cost_usd = ? WHERE job_id = ?").run(
      job.status,
      job.reason,
      job.cost_usd,
      jobId,
    );
  },
};
