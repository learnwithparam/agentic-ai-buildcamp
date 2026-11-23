// A worker that dies in the middle of a job. The guardrails check starts it as a real process.
import { rows } from "../packages/core/src/db";
import { saveStep, startWorker } from "../packages/core/src/jobs";

await startWorker(async (job) => {
  await rows("INSERT INTO job_effects VALUES ($1, 0)", [job.key]);
  await saveStep(job.key, 1);
  process.kill(process.pid, "SIGKILL");
});
