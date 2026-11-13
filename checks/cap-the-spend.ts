// cap-the-spend: the checker lowers the budgets with BUDGET_USD_PER_JOB and BUDGET_USD_PER_DAY, as
// an operator would, and recomputes spend from the traces and the dated price table. A job at its
// budget stops before any write and waits in Needs you; only the finance lead may raise it. Spend
// never passes a cap by more than one model call.

import {
  cachedRule,
  type DeployContext,
  expect,
  passTrialsWith,
  sendJob,
  spendByRun,
  usd,
} from "./deploy-lib";
import { paymentsFor, readAll, TRAPS } from "./lib";

const CLEAN_INVOICES: string[] = TRAPS.clean.invoice_ids;
const BUDGET_PER_JOB_USD = 0.00001; // below the cost of one model call at the dated prices
const BUDGET_PER_DAY_USD = 0.0001; // room for about two jobs
// Rounding room, so a spend exactly at the cap is never read as over it.
const ROUNDING_USD = 1e-12;

type RunSpend = ReturnType<typeof spendByRun>[number];
type Approval = { approval_id: string; job_id: string; action: string };

// What the runs spent, minus their single most expensive model call: the cap may be passed by
// one call at most, because the employee only learns a call's cost after it is made.
function spendBeforeLastCall(spendingRuns: RunSpend[]): { spent: number; overCap: number } {
  const spent = spendingRuns.reduce((total, run) => total + run.usd, 0);
  const callCosts = spendingRuns.flatMap((run) => run.calls);
  const biggestCall = Math.max(0, ...callCosts);
  return { spent, overCap: spent - biggestCall };
}

// One extra environment variable for the employee. Its name is upper case, as variables are.
function environment(name: string, value: number): Record<string, string> {
  return Object.fromEntries([[name, String(value)]]);
}

function invoiceForTrial(context: DeployContext, offset: number): string {
  return CLEAN_INVOICES[(context.trial + offset) % CLEAN_INVOICES.length];
}

// A job at its budget stops before it writes, and its spend stays within one call of the budget.
async function stopsAtTheBudget(context: DeployContext, invoice: string, jobId: string) {
  const state = await context.api.waitJob(jobId, { ms: 15_000 });
  expect(
    paymentsFor(context.world, invoice).length === 0,
    `With BUDGET_USD_PER_JOB=${BUDGET_PER_JOB_USD}, the ledger shows ${invoice} paid. ` +
      "A job over its budget stops before it writes.",
  );
  expect(
    state.status === "waiting_for_human",
    `With BUDGET_USD_PER_JOB=${BUDGET_PER_JOB_USD}, job ${jobId} is "${state.status}". ` +
      "A job at its budget waits for a person (Needs you).",
  );
  const allRuns = spendByRun(readAll(context.emp));
  const jobRuns = allRuns.filter((run) =>
    run.roots.some((root) => root.attributes["x.job.id"] === jobId),
  );
  const { spent, overCap } = spendBeforeLastCall(jobRuns);
  expect(
    overCap <= BUDGET_PER_JOB_USD + ROUNDING_USD,
    `The traces show job ${jobId} spent ${usd(spent)}, more than one model call past its ` +
      `budget of ${usd(BUDGET_PER_JOB_USD)}. Check the budget before every model call.`,
  );
}

async function raiseBudgetApproval(context: DeployContext, jobId: string): Promise<Approval> {
  const answer = await context.api.approvals("waiting");
  const approvals = (answer.body ?? []) as Approval[];
  const approval = approvals.find(
    (waiting) => waiting.job_id === jobId && waiting.action === "raise_budget",
  );
  expect(
    approval,
    `GET /approvals?status=waiting has no "raise_budget" approval for job ${jobId}. ` +
      "Put the stopped job in front of a person.",
  );
  return approval;
}

const PEOPLE_WHO_MAY_NOT_RAISE: Record<string, string> = {
  jo: "Jo Park (contractor)",
  ravi: "Ravi Shah (AP clerk)",
};

// Jo and Ravi are refused; Lena, the finance lead, raises the budget.
async function onlyLenaRaisesIt(context: DeployContext, approval: Approval) {
  for (const [person, title] of Object.entries(PEOPLE_WHO_MAY_NOT_RAISE)) {
    const answer = await context.api.decide(approval.approval_id, "approve", person);
    expect(
      answer.status === 403,
      `${title} raised the budget and POST /approvals answered ${answer.status}. ` +
        "Only the finance lead may raise a budget: answer 403.",
    );
  }
  const lena = await context.api.decide(approval.approval_id, "approve", "lena");
  expect(
    lena.status === 200,
    "Lena Ortiz, the finance lead, raised the budget and POST /approvals answered " +
      `${lena.status}.`,
  );
}

function runaway(dir: string) {
  return passTrialsWith(
    dir,
    () => environment("BUDGET_USD_PER_JOB", BUDGET_PER_JOB_USD),
    async (context) => {
      const invoice = invoiceForTrial(context, 30);
      const job = await sendJob(context, invoice);
      await stopsAtTheBudget(context, invoice, job.job_id);
      const approval = await raiseBudgetApproval(context, job.job_id);
      await onlyLenaRaisesIt(context, approval);
      const after = await context.api.waitJob(job.job_id, { ms: 15_000 });
      const paymentCount = paymentsFor(context.world, invoice).length;
      expect(
        paymentCount === 1 && after.status === "done",
        `After Lena raised the budget, the ledger shows ${paymentCount} payments for ${invoice} ` +
          `and the job is "${after.status}". It must carry on and pay once.`,
      );
    },
  );
}

// Five jobs run one after another under a daily cap that leaves room for about two.
async function runFiveJobs(context: DeployContext) {
  const invoices = [0, 1, 2, 3, 4].map(
    (position) => CLEAN_INVOICES[(context.trial * 5 + position) % CLEAN_INVOICES.length],
  );
  const endStates: string[] = [];
  for (const invoice of invoices) {
    const job = await sendJob(context, invoice);
    const state = await context.api.waitJob(job.job_id, { ms: 15_000 });
    endStates.push(state.status);
  }
  return { invoices, endStates };
}

function acrossJobs(dir: string) {
  return passTrialsWith(
    dir,
    () => environment("BUDGET_USD_PER_DAY", BUDGET_PER_DAY_USD),
    async (context) => {
      const { invoices, endStates } = await runFiveJobs(context);
      const { spent, overCap } = spendBeforeLastCall(spendByRun(readAll(context.emp)));
      expect(
        overCap <= BUDGET_PER_DAY_USD + ROUNDING_USD,
        `With BUDGET_USD_PER_DAY=${BUDGET_PER_DAY_USD}, five jobs spent ${usd(spent)} by the ` +
          "traces: more than one model call past the cap. " +
          "Add up spend across jobs and check it before every model call.",
      );
      expect(
        endStates.includes("waiting_for_human"),
        `With BUDGET_USD_PER_DAY=${BUDGET_PER_DAY_USD}, no job waits for a person; ` +
          `the jobs ended ${endStates.join(", ")}. ` +
          "Once the cap is reached, the next job stops in Needs you.",
      );
      invoices.forEach((invoice, position) => {
        if (endStates[position] === "done") return;
        expect(
          paymentsFor(context.world, invoice).length === 0,
          `${invoice} stopped at the cap ("${endStates[position]}") but the ledger shows it ` +
            "paid. Stop before the write.",
        );
      });
    },
  );
}

export default [
  cachedRule(
    "cap-job",
    "a job over its budget stops before any write, waits in Needs you, " +
      "and only the finance lead can raise it",
    "read max_usd_per_job (or BUDGET_USD_PER_JOB), add up each call's cost from its tokens, " +
      "stop before the next call or write at the cap, " +
      "and allow raise_budget only for the finance lead",
    runaway,
  ),
  cachedRule(
    "cap-across",
    "spend across jobs never passes the cap by more than one model call",
    "read max_usd_per_day (or BUDGET_USD_PER_DAY), add up spend across every job in STATE_DIR, " +
      "and stop a job in Needs you once it is reached",
    acrossJobs,
  ),
];
