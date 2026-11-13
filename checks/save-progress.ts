// save-progress: a job that waits for Lena is killed and restarted. The approval must still wait,
// Lena's approval must pay it once, and the world's access log and the traces must show the
// finished steps were not done again: each piece of evidence read once, the model asked once.

import {
  cachedRule,
  type DeployContext,
  expect,
  passTrialsWith,
  runs,
  sendJob,
} from "./deploy-lib";
import { paymentsFor, readAll, spansNamed, TRAPS } from "./lib";

const INVOICE = TRAPS.over_ravi_limit.invoice_id;
const EVIDENCE_TOOLS = ["find_load", "read_rate_confirmation", "read_proof_of_delivery"];

// The rows the checker reads from GET /approvals and from the world's access log.
type Approval = { approval_id: string; job_id: string };
type AccessLogEntry = { job_id: string; tool: string };

// Before the kill, the job must already be waiting for Lena; after the restart it must still wait.
async function stillWaitsAfterRestart(context: DeployContext, jobId: string) {
  const before = await context.api.waitJob(jobId, { ms: 15_000 });
  expect(
    before.status === "waiting_for_human",
    `${INVOICE} is over Ravi's limit, so the job must wait for Lena before the restart. ` +
      `Your employee says "${before.status}". Pass ask-for-approval first.`,
  );
  await context.emp.kill();
  await context.emp.restart();
  const after = await context.api.readJob(jobId);
  expect(
    after.status === 200,
    `After the restart, GET /jobs/${jobId} answered ${after.status}. ` +
      "Save each job in STATE_DIR, not in memory.",
  );
  expect(
    after.body?.status === "waiting_for_human",
    `After the restart the job is "${after.body?.status}". ` +
      "It was waiting for Lena; it must still wait.",
  );
}

// Lena approves the saved approval, and the ledger shows exactly one payment.
async function lenaApprovesAndItPaysOnce(context: DeployContext, jobId: string) {
  const answer = await context.api.approvals("waiting");
  const approvals = (answer.body ?? []) as Approval[];
  const approval = approvals.find((waiting) => waiting.job_id === jobId);
  expect(
    approval,
    `After the restart, GET /approvals?status=waiting no longer lists job ${jobId}. ` +
      "Save approvals in STATE_DIR too.",
  );
  const lena = await context.api.decide(approval.approval_id, "approve", "lena");
  expect(
    lena.status === 200,
    `Lena approved after the restart, but POST /approvals answered ${lena.status}.`,
  );
  const done = await context.api.waitJob(jobId, { ms: 15_000 });
  const paymentCount = paymentsFor(context.world, INVOICE).length;
  expect(
    paymentCount === 1,
    `After the restart and Lena's approval the ledger shows ${paymentCount} payments for ` +
      `${INVOICE}. It must show one.`,
  );
  expect(
    done.status === "done",
    `The ledger shows ${INVOICE} paid, but your employee says "${done.status}".`,
  );
}

// A finished step is saved, so the resume reads each piece of evidence only once.
function evidenceReadOnce(context: DeployContext, jobId: string) {
  const accessLog = context.world.accessLog() as AccessLogEntry[];
  const reads = accessLog.filter((entry) => entry.job_id === jobId);
  for (const tool of EVIDENCE_TOOLS) {
    const count = reads.filter((entry) => entry.tool === tool).length;
    expect(
      count === 1,
      `The world's access log shows ${tool} ${count} times for job ${jobId}. ` +
        "A finished step is saved, so a resume does not read the evidence again.",
    );
  }
}

// The draft was saved before the restart, so the traces show one model call for the job.
function modelAskedOnce(context: DeployContext, jobId: string) {
  const allRuns = runs(readAll(context.emp));
  const jobRuns = allRuns.filter((run) =>
    run.roots.some((root) => root.attributes["x.job.id"] === jobId),
  );
  expect(
    jobRuns.length > 0,
    `No trace has a root invoke_agent span with x.job.id = ${jobId}. Label each run with its job.`,
  );
  const modelCalls = jobRuns.flatMap((run) => spansNamed(run.spans, "chat")).length;
  expect(
    modelCalls === 1,
    `The traces show ${modelCalls} model calls for job ${jobId}. ` +
      "The draft was saved before the restart, so the model is asked once.",
  );
}

function killWhileWaiting(dir: string) {
  return passTrialsWith(
    dir,
    () => ({}),
    async (context) => {
      const job = await sendJob(context, INVOICE);
      await stillWaitsAfterRestart(context, job.job_id);
      await lenaApprovesAndItPaysOnce(context, job.job_id);
      evidenceReadOnce(context, job.job_id);
      modelAskedOnce(context, job.job_id);
    },
  );
}

export default [
  cachedRule(
    "save-progress",
    "a job killed while it waits for Lena still waits after the restart, " +
      "her approval pays it once, and no finished step is done again",
    "keep jobs, approvals and each finished step (the evidence, the draft) in STATE_DIR, " +
      "and on start carry on from the last saved step",
    killWhileWaiting,
  ),
];
