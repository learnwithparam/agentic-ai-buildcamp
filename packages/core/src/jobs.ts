// Jobs run on pg-boss, a queue that lives in Postgres. One key means one job.
// A job that fails waits and tries again. A job that always fails goes to the dead letter queue.
import { PgBoss } from "pg-boss";
import { DATABASE_URL, rows } from "./db";

export type Job = { id: string; key: string; payload: string; step: number };
export type Handler = (job: Job) => Promise<void>;
type Data = { key: string; payload: string };

export const QUEUE = "label-change";
export const DEAD_QUEUE = "label-change-dead";
export const NIGHTLY_QUEUE = "label-watch-nightly";
export const NIGHTLY_CRON = "0 2 * * *";
export const MAX_ATTEMPTS = 3;
const RETRY_SECONDS = 1;
const DRAIN_MS = 20_000;

let boss: PgBoss | undefined;

// #region step:guardrails-workers
export async function startJobs(): Promise<PgBoss> {
  if (boss !== undefined) return boss;
  // The supervisor looks for jobs whose worker stopped. A short wait means a crash heals fast.
  const queue = new PgBoss({
    connectionString: DATABASE_URL,
    superviseIntervalSeconds: 2,
    monitorIntervalSeconds: 2,
  });
  queue.on("error", (error) => console.error(`pg-boss: ${error.message}`));
  await queue.start();
  await queue.createQueue(DEAD_QUEUE);
  await queue.createQueue(NIGHTLY_QUEUE);
  await queue.createQueue(QUEUE, {
    policy: "exclusive",
    retryLimit: MAX_ATTEMPTS - 1,
    retryDelay: RETRY_SECONDS,
    retryBackoff: true,
    deadLetter: DEAD_QUEUE,
  });
  await rows("CREATE TABLE IF NOT EXISTS job_steps (key text PRIMARY KEY, step int NOT NULL)");
  boss = queue;
  return queue;
}

// Returns true when the job is new. A key that is already waiting or running is ignored.
export async function enqueue(
  key: string,
  payload: string,
  expireInSeconds?: number,
): Promise<boolean> {
  const queue = await startJobs();
  const data: Data = { key, payload };
  const options = expireInSeconds === undefined ? {} : { expireInSeconds };
  const id = await queue.send(QUEUE, data, { singletonKey: key, ...options });
  return id !== null;
}

// Saves how far the job got, so a new worker starts there and not at the beginning.
export async function saveStep(key: string, step: number): Promise<void> {
  await rows(
    `INSERT INTO job_steps (key, step) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET step = $2`,
    [key, step],
  );
}

async function savedStep(key: string): Promise<number> {
  const [row] = await rows<{ step: number }>("SELECT step FROM job_steps WHERE key = $1", [key]);
  return row?.step ?? 0;
}

// Starts one worker. If the handler throws, pg-boss retries it later with a longer wait each time.
export async function startWorker(handler: Handler): Promise<void> {
  const queue = await startJobs();
  await queue.work<Data>(QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
    const { key, payload } = job.data;
    await handler({ id: job.id, key, payload, step: await savedStep(key) });
  });
}

// Every night the schedule adds one watch job. The date in the key makes a second add do nothing.
export async function scheduleNightly(): Promise<void> {
  const queue = await startJobs();
  await queue.schedule(NIGHTLY_QUEUE, NIGHTLY_CRON);
  await queue.work(NIGHTLY_QUEUE, async () => {
    await enqueue(`label-watch:${new Date().toISOString().slice(0, 10)}`, "nightly");
  });
}

// The keys of jobs that failed every try. A person looks at these later.
export async function deadKeys(): Promise<string[]> {
  const found = await rows<{ key: string }>(
    "SELECT data->>'key' AS key FROM pgboss.job WHERE name = $1 ORDER BY created_on",
    [DEAD_QUEUE],
  );
  return found.map((row) => row.key);
}

// On SIGTERM the worker finishes the job in hand, then stops. A job it never started stays queued.
export async function stopJobs(): Promise<void> {
  if (boss === undefined) return;
  const queue = boss;
  boss = undefined;
  await queue.stop({ graceful: true, timeout: DRAIN_MS });
}

export function drainOnSigterm(): void {
  process.once("SIGTERM", async () => {
    await stopJobs();
    process.exit(0);
  });
}
// #stub
//~ // TODO(guardrails-workers): keep one job per key, retry with a wait, and drain on SIGTERM
//~ export async function startJobs(): Promise<PgBoss> {
//~   return new PgBoss(DATABASE_URL);
//~ }
//~
//~ export async function enqueue(
//~   _key: string,
//~   _payload: string,
//~   _expireInSeconds?: number,
//~ ): Promise<boolean> {
//~   return true;
//~ }
//~
//~ export async function saveStep(_key: string, _step: number): Promise<void> {}
//~
//~ export async function startWorker(_handler: Handler): Promise<void> {}
//~
//~ export async function scheduleNightly(): Promise<void> {}
//~
//~ export async function deadKeys(): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function stopJobs(): Promise<void> {}
//~
//~ export function drainOnSigterm(): void {}
// #endregion

// Test helper. It rebuilds the queue and clears the dead letter queue and the step notes.
export async function resetJobs(): Promise<void> {
  const queue = await startJobs();
  await queue.deleteQueue(QUEUE);
  await queue.deleteAllJobs(DEAD_QUEUE);
  await stopJobs();
  await startJobs();
  await rows("TRUNCATE job_steps");
  await rows("DROP TABLE IF EXISTS job_effects");
  await rows("CREATE TABLE job_effects (key text, step int, PRIMARY KEY (key, step))");
}
