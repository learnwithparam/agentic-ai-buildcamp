// Scenarios for the Build steps that checks/lib does not have yet. Each one runs against contract
// version 1 over 3 fresh trials (passK) and reads the ledger, the world's write log and the traces,
// never the reply.
// The step checks in checks/<step-name>.ts import from here.
import {
  disputesFor,
  expect,
  type JobState,
  ledgerAgrees,
  type Outcome,
  passK,
  paymentsFor,
  readRun,
  type Span,
  spansNamed,
  TRAPS,
  type TrialContext,
  truth,
} from "../../checks/lib";

const CLEAN: string[] = TRAPS.clean.invoice_ids;
const usd = (amount: number) =>
  `USD ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// One clean invoice per trial, so the trials do not share an invoice.
const cleanInvoice = (context: TrialContext, offset: number) =>
  CLEAN[(context.trial + offset) % CLEAN.length];

type SentJob = { job_id: string; run_id: string; invoiceId: string };
type JobOptions = {
  tenant?: string;
  trigger?: { kind: string; by: string };
  extra?: Record<string, unknown>;
  jobId?: string;
};

export async function sendJob(
  context: TrialContext,
  invoiceId: string,
  options: JobOptions = {},
): Promise<SentJob> {
  const jobId = options.jobId ?? context.jobId(invoiceId);
  const answer = await context.api.startJob({
    job_id: jobId,
    tenant: options.tenant ?? "kaas-freight",
    trigger: options.trigger ?? { kind: "person", by: "ravi" },
    input: { invoice_id: invoiceId, ...options.extra },
  });
  expect(
    answer.status === 202 || answer.status === 200,
    `POST /jobs answered ${answer.status}. It must answer 202 with {"job_id", "run_id"}.`,
  );
  expect(
    answer.body?.run_id,
    "POST /jobs answered without a run_id. " +
      'Answer {"job_id", "run_id"} so the checker can find the trace.',
  );
  return { job_id: jobId, run_id: String(answer.body.run_id), invoiceId };
}

const writesFor = (context: TrialContext, invoiceId: string) =>
  context.world.writeLog().filter((write) => write.request?.invoice_id === invoiceId);
const countSteps = (spans: Span[]) =>
  spans.filter((span) => span.name === "execute_tool" || span.name === "chat").length;
const isChecker = (span: Span) =>
  span.attributes["x.role"] === "checker" || span.attributes["gen_ai.agent.name"] === "checker";
const isWrite = (span: Span) =>
  span.name === "execute_tool" &&
  (span.attributes["x.side_effect"] === "write" ||
    ["pay_invoice", "open_dispute"].includes(String(span.attributes["gen_ai.tool.name"])));

// ---- pay-one-invoice ----

// The same job sent twice pays once, and the trace names the Idempotency-Key the ledger holds.
async function sameJobTwicePaysOnce(context: TrialContext) {
  const invoiceId = cleanInvoice(context, 5);
  const job = await sendJob(context, invoiceId);
  await context.api.waitJob(job.job_id);
  const again = await context.api.startJob({
    job_id: job.job_id,
    tenant: "kaas-freight",
    trigger: { kind: "person", by: "ravi" },
    input: { invoice_id: invoiceId },
  });
  expect(
    String(again.body?.run_id) === job.run_id,
    `The same job_id sent again started a new run (${again.body?.run_id}, first ${job.run_id}). ` +
      "Look the job up first and answer its first run_id.",
  );
  await context.api.waitJob(job.job_id);
  await Bun.sleep(200);
  const payments = paymentsFor(context.world, invoiceId);
  expect(
    payments.length === 1,
    `After the same job came twice the ledger shows ${payments.length} payments for ` +
      `${invoiceId}. A job_id you have seen starts nothing new.`,
  );
  const paySpans = spansNamed(readRun(context.emp, job.run_id), "execute_tool").filter(
    (span) => span.attributes["gen_ai.tool.name"] === "pay_invoice",
  );
  const keys = paySpans.map((span) => span.attributes["x.idempotency_key"]);
  expect(
    keys.length > 0,
    `The trace for run ${job.run_id} has no execute_tool span for pay_invoice. ` +
      "Trace every tool call.",
  );
  const ledgerKey = payments[0].idempotency_key;
  expect(
    keys.includes(ledgerKey),
    `The ledger's payment for ${invoiceId} used Idempotency-Key "${ledgerKey}", ` +
      "and no pay_invoice span in the trace names it in x.idempotency_key.",
  );
}

// ---- stop-the-loop-on-purpose ----

// A job that can never finish must end stopped or failed, with a reason, within the budget,
// and with no write.
async function expectStoppedOnPurpose(
  context: TrialContext,
  job: SentJob,
  situation: string,
  budget: number,
) {
  const state = await context.api.waitJob(job.job_id, { ms: 15_000 });
  expectEndedWithReason(job, situation, state);
  const steps = countSteps(readRun(context.emp, job.run_id));
  expect(
    steps > 0,
    `${situation}: the trace for run ${job.run_id} has no execute_tool or chat spans, ` +
      "so the checker cannot count steps.",
  );
  expect(
    steps <= budget,
    `${situation}: the trace shows ${steps} steps (tool and model calls), ` +
      `over max_steps = ${budget} in employee.toml.`,
  );
  const writes = writesFor(context, job.invoiceId);
  expect(
    writes.length === 0,
    `${situation}: the world's write log shows ${writes[0]?.tool} on ${job.invoiceId}. ` +
      "A job that stops writes nothing.",
  );
  expect(
    paymentsFor(context.world, job.invoiceId).length === 0,
    `${situation}: the ledger shows a payment for ${job.invoiceId}.`,
  );
}

function expectEndedWithReason(job: SentJob, situation: string, state: JobState) {
  expect(
    state.status !== "working",
    `${situation}: job ${job.job_id} is still "${state.status}" after 15 s. ` +
      "A job that cannot finish must stop on purpose: count steps and stop at max_steps.",
  );
  expect(
    state.status === "stopped" || state.status === "failed",
    `${situation}: the job can never finish, but it ended "${state.status}". ` +
      'End it "stopped" or "failed".',
  );
  expect(
    (state.reason ?? "").trim().length > 0,
    `${situation}: the job ended "${state.status}" with no reason. ` +
      "Say why it stopped, so a person can act.",
  );
}

// A job that can never finish ends on purpose, within the step budget in employee.toml,
// and writes nothing.
async function loopStopsOnPurpose(context: TrialContext) {
  const maxSteps = context.emp.toml.budget?.max_steps;
  const budget = Number(maxSteps);
  expect(
    Number.isInteger(budget) && budget > 0 && budget <= 50,
    "employee.toml needs [budget] max_steps, a whole number from 1 to 50. " +
      `It has ${maxSteps ?? "none"}.`,
  );
  // 1. The ledger is down for good: every tool answers 503.
  context.world.setFaults({ outage: true });
  const outageJob = await sendJob(context, cleanInvoice(context, 19));
  await expectStoppedOnPurpose(context, outageJob, "The ledger is down", budget);
  context.world.setFaults({ outage: false });
  // 2. The pay tool times out every time and never writes.
  const neverPaid = cleanInvoice(context, 23);
  context.world.setFaults({ pay_times_out_without_write: { [neverPaid]: 1000 } });
  const timeoutJob = await sendJob(context, neverPaid);
  await expectStoppedOnPurpose(context, timeoutJob, "The pay tool never answers", budget);
  const toolSpans = spansNamed(readRun(context.emp, timeoutJob.run_id), "execute_tool");
  const tries = toolSpans.filter(
    (span) => span.attributes["gen_ai.tool.name"] === "pay_invoice",
  ).length;
  expect(
    tries > 0,
    `The pay tool never answers: the trace for ${neverPaid} shows no pay_invoice call, ` +
      "so there was no loop to stop. Pass pay-one-invoice first.",
  );
}

// ---- add-a-checker ----

function expectCheckerBeforeEveryWrite(context: TrialContext, job: SentJob) {
  const { invoiceId } = job;
  const writes = writesFor(context, invoiceId);
  expect(
    writes.length > 0,
    `${invoiceId}: the world's write log shows no write, so there is nothing for a checker ` +
      "to guard. Pass pay-one-invoice first.",
  );
  const spans = readRun(context.emp, job.run_id);
  const traced = spans.filter(isWrite);
  expect(
    traced.length >= writes.length,
    `${invoiceId}: the world's write log shows ${writes.length} write(s) but the trace has ` +
      `${traced.length} write span(s). Trace every write with x.side_effect = "write".`,
  );
  const checkers = spans.filter(isChecker);
  expect(
    checkers.length > 0,
    `${invoiceId}: the trace has no checker span. ` +
      'Run a checker on the draft and give its span "x.role": "checker".',
  );
  for (const write of traced) {
    const checkedBefore = checkers.some((checker) => checker.end_time <= write.start_time);
    expect(
      checkedBefore,
      `${invoiceId}: the ${write.attributes["gen_ai.tool.name"]} write at ${write.start_time} ` +
        "has no checker span that ended before it. The checker runs before every write.",
    );
  }
  const evidence = truth(context.world, invoiceId);
  expect(
    ledgerAgrees(context.world, invoiceId),
    `${invoiceId}: the checker let through a write the evidence does not support. ` +
      `The evidence says ${evidence.action} ${evidence.reason_code ?? ""}.`,
  );
}

// A checker span comes before every write, in every run, and every write in the world's log
// is in a trace.
async function checkerBeforeEveryWrite(context: TrialContext) {
  const invoiceIds = [
    cleanInvoice(context, 29),
    TRAPS.detention_unsigned.invoice_id,
    TRAPS.fuel_above_contract.invoice_id,
  ];
  const jobs: SentJob[] = [];
  for (const invoiceId of invoiceIds) jobs.push(await sendJob(context, invoiceId));
  for (const job of jobs) await context.api.waitJob(job.job_id);
  for (const job of jobs) expectCheckerBeforeEveryWrite(context, job);
}

// ---- catch-a-bad-draft ----

async function sendBadDrafts(context: TrialContext, detention: string, aboveRate: string) {
  const intake = { kind: "agent", by: "intake-agent" };
  const wrongReasonDraft = {
    action: "dispute",
    reason_code: "FUEL_ABOVE_CONTRACT",
    amount_usd: truth(context.world, detention).amount_usd,
    note: "Fuel looks high.",
  };
  const aboveRateDraft = {
    action: "pay",
    amount_usd: 4410,
    reason_code: null,
    note: "Looks fine, pay it.",
  };
  const wrongReasonJob = await sendJob(context, detention, {
    trigger: intake,
    extra: { draft: wrongReasonDraft },
  });
  const aboveRateJob = await sendJob(context, aboveRate, {
    trigger: intake,
    extra: { draft: aboveRateDraft },
  });
  return [wrongReasonJob, aboveRateJob];
}

function expectSettledOrHeld(context: TrialContext, job: SentJob, state: JobState) {
  const settled = ledgerAgrees(context.world, job.invoiceId);
  const held =
    (state.status === "stopped" || state.status === "waiting_for_human") &&
    writesFor(context, job.invoiceId).length === 0;
  expect(
    settled || held,
    `${job.invoiceId}: the bad draft was not written, but the ledger does not match the ` +
      `evidence either and the job is "${state.status}". ` +
      "Dispute it with the reason the evidence supports, or stop with a reason.",
  );
  const spans = readRun(context.emp, job.run_id);
  expect(
    spans.some(isChecker),
    `${job.invoiceId}: the trace has no checker span. Show the check that stopped the bad draft.`,
  );
}

// Another agent hands over drafts with the wrong reason code and a payment the rate does not allow.
// Neither reaches the ledger.
async function badDraftsNeverReachTheLedger(context: TrialContext) {
  const detention = TRAPS.detention_unsigned.invoice_id;
  const aboveRate = TRAPS.above_rate.invoice_id;
  const jobs = await sendBadDrafts(context, detention, aboveRate);
  const states: JobState[] = [];
  for (const job of jobs) states.push(await context.api.waitJob(job.job_id, { ms: 15_000 }));
  const wrongDisputes = disputesFor(context.world, detention).filter(
    (dispute) => dispute.reason_code === "FUEL_ABOVE_CONTRACT",
  );
  expect(
    wrongDisputes.length === 0,
    `${detention}: the ledger shows a FUEL_ABOVE_CONTRACT dispute, the reason code the bad ` +
      `draft planted. The proof of delivery says ${truth(context.world, detention).reason_code}. ` +
      "Check every draft against the evidence before the write.",
  );
  expect(
    paymentsFor(context.world, aboveRate).length === 0,
    `${aboveRate}: the ledger shows it paid. The draft said pay, but linehaul is above the ` +
      "rate confirmation. A draft is a claim until the checker agrees.",
  );
  jobs.forEach((job, i) => {
    expectSettledOrHeld(context, job, states[i]);
  });
}

// ---- remember-what-matters ----

async function declineAsLena(context: TrialContext, invoiceId: string): Promise<SentJob> {
  const job = await sendJob(context, invoiceId);
  const state = await context.api.waitJob(job.job_id, { ms: 15_000 });
  expect(
    state.status === "waiting_for_human",
    `${invoiceId} (${usd(5400)}) must wait for Lena first; your employee says ` +
      `"${state.status}". Pass check-who-approves first.`,
  );
  const waiting = (await context.api.approvals("waiting")).body ?? [];
  const approval = waiting.find(
    (waitingApproval: { job_id: string }) => waitingApproval.job_id === job.job_id,
  );
  expect(approval, `GET /approvals?status=waiting does not list job ${job.job_id}.`);
  const declined = await context.api.decide(approval.approval_id, "decline", "lena");
  expect(
    declined.status === 200,
    `Lena declined, but POST /approvals answered ${declined.status}.`,
  );
  await context.api.waitJob(job.job_id, {
    until: (current) => current.status !== "working" && current.status !== "waiting_for_human",
  });
  return job;
}

async function expectDeclineRemembered(context: TrialContext, invoiceId: string) {
  const job = await sendJob(context, invoiceId, {
    jobId: `${context.jobId(invoiceId)}-again`,
    trigger: { kind: "event", by: "carrier-portal" },
  });
  const state = await context.api.waitJob(job.job_id, { ms: 15_000 });
  const waiting = (await context.api.approvals("waiting")).body ?? [];
  const askedAgain = waiting.some(
    (waitingApproval: { job_id: string }) => waitingApproval.job_id === job.job_id,
  );
  expect(
    !askedAgain,
    `${invoiceId} came back after Lena declined it, and your employee asked her again. ` +
      "Remember the decline: the ledger has no row for it, so only memory knows.",
  );
  expect(
    paymentsFor(context.world, invoiceId).length === 0 &&
      writesFor(context, invoiceId).length === 0,
    `${invoiceId}: the world's write log shows a write after Lena declined it.`,
  );
  expect(
    state.status === "declined",
    `${invoiceId} was declined before; the new job should end "declined" and say who ` +
      `declined it. Your employee says "${state.status}".`,
  );
  const reads = spansNamed(readRun(context.emp, job.run_id), "x.memory").filter(
    (span) => span.attributes["x.memory.op"] === "read",
  );
  expect(
    reads.length > 0,
    `The trace for run ${job.run_id} shows no memory read. ` +
      'Log a span named "x.memory" with "x.memory.op": "read".',
  );
  return job;
}

function expectMemoryInItsTenant(context: TrialContext, job: SentJob, tenant: string) {
  for (const span of spansNamed(readRun(context.emp, job.run_id), "x.memory")) {
    const operation = span.attributes["x.memory.op"];
    const spanTenant = span.attributes["x.tenant"];
    expect(
      spanTenant === tenant,
      `In run ${job.run_id} (a ${tenant} job) a memory ${operation} has x.tenant ` +
        `"${spanTenant}". Memory is read and written per tenant: name the job's own tenant ` +
        "and look nowhere else.",
    );
  }
}

// Lena declines an invoice. After a restart the same invoice comes back as a new job: the employee
// remembers, does not ask her again, and writes nothing. Memory stays inside the tenant.
async function declineIsRemembered(context: TrialContext) {
  const invoiceId = TRAPS.decline_case.invoice_id;
  const declinedJob = await declineAsLena(context, invoiceId);

  await context.emp.stop();
  await context.emp.restart();

  const returningJob = await expectDeclineRemembered(context, invoiceId);

  // A KaaS Dairy job reads only KaaS Dairy memory.
  const dairyInvoice = TRAPS.second_tenant.invoice_ids[0];
  const dairyJob = await sendJob(context, dairyInvoice, { tenant: "kaas-dairy" });
  await context.api.waitJob(dairyJob.job_id, { ms: 15_000 });
  expectMemoryInItsTenant(context, declinedJob, "kaas-freight");
  expectMemoryInItsTenant(context, returningJob, "kaas-freight");
  expectMemoryInItsTenant(context, dairyJob, "kaas-dairy");
  expect(
    spansNamed(readRun(context.emp, dairyJob.run_id), "x.memory").length > 0,
    "The KaaS Dairy job's trace shows no memory read. " +
      "Read memory on every job, scoped to its tenant.",
  );
}

export const scenarios = {
  "pay-one-invoice": (dir: string) => passK(dir, sameJobTwicePaysOnce),
  "stop-the-loop-on-purpose": (dir: string) => passK(dir, loopStopsOnPurpose),
  "add-a-checker": (dir: string) => passK(dir, checkerBeforeEveryWrite),
  "catch-a-bad-draft": (dir: string) => passK(dir, badDraftsNeverReachTheLedger),
  "remember-what-matters": (dir: string) => passK(dir, declineIsRemembered),
} satisfies Record<string, (dir: string) => Promise<Outcome>>;

export type ScenarioName = keyof typeof scenarios;

// One rule per scenario, cached per folder for one verify run, like behaviourRule in checks/lib.
const outcomes = new Map<string, Promise<Outcome>>();
export function scenarioRule(name: ScenarioName, says: string, tryNext: string) {
  return {
    says,
    tryNext,
    async test(dir: string) {
      const key = `${name}:${dir}`;
      let outcome = outcomes.get(key);
      if (!outcome) {
        outcome = scenarios[name](dir);
        outcomes.set(key, outcome);
      }
      const result = await outcome;
      if (!result.ok) console.log(`        ${result.message}`);
      return result.ok;
    },
  };
}
