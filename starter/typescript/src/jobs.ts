// The job table, saved in SQLite under STATE_DIR.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Job = {
  job_id: string;
  run_id: string;
  tenant: string;
  trigger: any;
  input: any;
  status: string;
  reason: string | null;
  cost_usd: number;
};

const dir = process.env.STATE_DIR ?? ".state";
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, "jobs.sqlite"), { create: true });
db.exec(
  "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT, trigger TEXT, input TEXT, status TEXT, reason TEXT, cost_usd REAL)",
);
const row = (r: any): Job | null =>
  r ? { ...r, trigger: JSON.parse(r.trigger), input: JSON.parse(r.input) } : null;

export const jobs = {
  get: (id: string) => row(db.query("SELECT * FROM jobs WHERE job_id = ?").get(id)),
  all: () => (db.query("SELECT * FROM jobs").all() as any[]).map((r) => row(r)!),
  add(j: Omit<Job, "status" | "reason" | "cost_usd">): Job {
    db.query("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)").run(
      j.job_id,
      j.run_id,
      j.tenant,
      JSON.stringify(j.trigger),
      JSON.stringify(j.input),
      "working",
      null,
      0,
    );
    return this.get(j.job_id)!;
  },
  set(id: string, patch: Partial<Pick<Job, "status" | "reason" | "cost_usd">>) {
    const j = { ...this.get(id)!, ...patch };
    db.query("UPDATE jobs SET status = ?, reason = ?, cost_usd = ? WHERE job_id = ?").run(
      j.status,
      j.reason,
      j.cost_usd,
      id,
    );
  },
};
