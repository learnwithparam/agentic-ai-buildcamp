// save-progress: a job that waits for Lena is killed and restarted. The approval must still wait, Lena's approval
// must pay it once, and the world's access log and the traces must show the finished steps were not done again:
// each piece of evidence read once, the model asked once.

import { cachedRule, expect, passKWith, runs, sendJob } from "./deploy-lib";
import { paymentsFor, readAll, spansNamed, TRAPS } from "./lib";

const INV = TRAPS.over_ravi_limit.invoice_id;
const EVIDENCE = ["find_load", "read_rate_confirmation", "read_proof_of_delivery"];

const killWhileWaiting = (dir: string) =>
  passKWith(
    dir,
    () => ({}),
    async (c) => {
      const j = await sendJob(c, INV);
      const s = await c.api.waitJob(j.job_id, { ms: 15_000 });
      expect(
        s.status === "waiting_for_human",
        `${INV} is over Ravi's limit, so the job must wait for Lena before the restart. Your employee says "${s.status}". Pass ask-for-approval first.`,
      );
      await c.emp.kill();
      await c.emp.restart();
      const after = await c.api.readJob(j.job_id);
      expect(
        after.status === 200,
        `After the restart, GET /jobs/${j.job_id} answered ${after.status}. Save each job in STATE_DIR, not in memory.`,
      );
      expect(
        after.body?.status === "waiting_for_human",
        `After the restart the job is "${after.body?.status}". It was waiting for Lena; it must still wait.`,
      );
      const ap = ((await c.api.approvals("waiting")).body ?? []).find(
        (x: any) => x.job_id === j.job_id,
      );
      expect(
        ap,
        `After the restart, GET /approvals?status=waiting no longer lists job ${j.job_id}. Save approvals in STATE_DIR too.`,
      );
      const lena = await c.api.decide(ap.approval_id, "approve", "lena");
      expect(
        lena.status === 200,
        `Lena approved after the restart, but POST /approvals answered ${lena.status}.`,
      );
      const done = await c.api.waitJob(j.job_id, { ms: 15_000 });
      const n = paymentsFor(c.world, INV).length;
      expect(
        n === 1,
        `After the restart and Lena's approval the ledger shows ${n} payments for ${INV}. It must show one.`,
      );
      expect(
        done.status === "done",
        `The ledger shows ${INV} paid, but your employee says "${done.status}".`,
      );

      const reads = c.world.accessLog().filter((r: any) => r.job_id === j.job_id);
      for (const tool of EVIDENCE) {
        const count = reads.filter((r: any) => r.tool === tool).length;
        expect(
          count === 1,
          `The world's access log shows ${tool} ${count} times for job ${j.job_id}. A finished step is saved, so a resume does not read the evidence again.`,
        );
      }
      const mine = runs(readAll(c.emp)).filter((r) =>
        r.roots.some((s) => s.attributes["x.job.id"] === j.job_id),
      );
      expect(
        mine.length > 0,
        `No trace has a root invoke_agent span with x.job.id = ${j.job_id}. Label each run with its job.`,
      );
      const calls = mine.flatMap((r) => spansNamed(r.spans, "chat")).length;
      expect(
        calls === 1,
        `The traces show ${calls} model calls for job ${j.job_id}. The draft was saved before the restart, so the model is asked once.`,
      );
    },
  );

export default [
  cachedRule(
    "save-progress",
    "a job killed while it waits for Lena still waits after the restart, her approval pays it once, and no finished step is done again",
    "keep jobs, approvals and each finished step (the evidence, the draft) in STATE_DIR, and on start carry on from the last saved step",
    killWhileWaiting,
  ),
];
