// Jobs live in Postgres. A job has one key, so the same event never runs twice.
// A worker leases a job. If the worker dies, the lease runs out and another worker takes over.
import { rows } from "./db";

export type Job = {
  id: number;
  key: string;
  payload: string;
  status: "queued" | "running" | "done" | "dead";
  attempts: number;
  step: number;
  last_error: string | null;
};
export type Handler = (job: Job) => Promise<void>;

export const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 30;

const TABLE = `CREATE TABLE IF NOT EXISTS jobs (id serial PRIMARY KEY, key text UNIQUE,
  payload text, status text DEFAULT 'queued', attempts int DEFAULT 0, step int DEFAULT 0,
  lease_until timestamptz, run_after timestamptz DEFAULT now(), last_error text)`;

export async function resetJobs(): Promise<void> {
  await rows("DROP TABLE IF EXISTS jobs, job_effects");
  await rows(TABLE);
  await rows("CREATE TABLE job_effects (job_id int, step int, PRIMARY KEY (job_id, step))");
}

// #region step:guardrails-workers
// Returns true when the job is new. A key that already exists is ignored.
export async function enqueue(key: string, payload: string): Promise<boolean> {
  const added = await rows(
    "INSERT INTO jobs (key, payload) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING id",
    [key, payload],
  );
  return added.length === 1;
}

// Takes one job that is waiting, or one whose worker stopped answering.
export async function claim(leaseSeconds = LEASE_SECONDS): Promise<Job | undefined> {
  const [job] = await rows<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1,
       lease_until = now() + $1 * interval '1 second'
     WHERE id = (SELECT id FROM jobs
       WHERE (status = 'queued' AND run_after <= now())
          OR (status = 'running' AND lease_until < now())
       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [leaseSeconds],
  );
  return job;
}

// Saves how far the job got, so a new worker starts there and not at the beginning.
export async function saveStep(id: number, step: number): Promise<void> {
  await rows("UPDATE jobs SET step = $2 WHERE id = $1", [id, step]);
}

// A failed job waits longer each time. After the last try it goes to the dead letter list.
async function fail(job: Job, error: unknown): Promise<void> {
  const message = String(error);
  if (job.attempts >= MAX_ATTEMPTS) {
    await rows("UPDATE jobs SET status = 'dead', last_error = $2 WHERE id = $1", [job.id, message]);
    return;
  }
  await rows(
    `UPDATE jobs SET status = 'queued', last_error = $2,
       run_after = now() + $3 * interval '1 second' WHERE id = $1`,
    [job.id, message, 2 ** job.attempts],
  );
}

export async function runNext(handler: Handler, leaseSeconds = LEASE_SECONDS): Promise<boolean> {
  const job = await claim(leaseSeconds);
  if (job === undefined) return false;
  try {
    await handler(job);
    await rows("UPDATE jobs SET status = 'done' WHERE id = $1", [job.id]);
  } catch (error) {
    await fail(job, error);
  }
  return true;
}
// #stub
//~ // TODO(guardrails-workers): add a job once per key, lease it, resume it and retry it
//~ export async function enqueue(_key: string, _payload: string): Promise<boolean> {
//~   return true;
//~ }
//~
//~ export async function claim(_leaseSeconds = LEASE_SECONDS): Promise<Job | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function saveStep(_id: number, _step: number): Promise<void> {}
//~
//~ export async function runNext(_handler: Handler, _leaseSeconds = LEASE_SECONDS) {
//~   return false;
//~ }
// #endregion
