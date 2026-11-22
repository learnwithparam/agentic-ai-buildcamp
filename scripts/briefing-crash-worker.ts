// A worker that dies right after it drafts a briefing. The always-on check starts it as a process.
import { handleJob } from "../apps/product-teammates/src/always-on";
import { runNext } from "../packages/core/src/jobs";

await runNext(async (job) => {
  await handleJob(job, () => process.kill(process.pid, "SIGKILL"));
}, 1);
