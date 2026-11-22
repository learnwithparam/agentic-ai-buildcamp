// A worker that dies in the middle of a job. The guardrails check starts it as a real process.
import { rows } from "../packages/core/src/db";
import { runNext, saveStep } from "../packages/core/src/jobs";

await runNext(async (job) => {
  await rows("INSERT INTO job_effects VALUES ($1, 0)", [job.id]);
  await saveStep(job.id, 1);
  process.kill(process.pid, "SIGKILL");
}, 1);
