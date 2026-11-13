// The Deploy part's employee: the reference freight audit clerk, with what production asks of it.
// It answers contract version 1 (reference/CONTRACT.md). It adds two triggers (a webhook and a
// timer), a budget per job and across jobs, and a policy file read from POLICY_FILE.
// Each solution/ and wrong/ folder in this part starts it with one Options object.
// A wrong/ folder plants exactly one mistake a learner makes.
// Models are called only through reference/src/model.ts, which asks config/models.ts by role.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd } from "../../config/models";
import {
  allowedTotal,
  type Evidence,
  expected,
  type Invoice,
  type Load,
  type ProofOfDelivery,
  promptEvidence,
  type RateConfirmation,
  SYSTEM_PROMPT,
} from "../../reference/src/audit";
import { boardPage } from "../../reference/src/board-page";
import { chat, type Reply } from "../../reference/src/model";
import {
  type Approval,
  type Draft,
  type Job,
  type JobSteps,
  openStore,
} from "../../reference/src/store";
import { tracer } from "../../reference/src/trace";
import { ToolFailed, worldClient } from "../../reference/src/world";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];

export type Options = {
  persist: boolean; // keep jobs in STATE_DIR so a restart knows them
  saveSteps: boolean; // save each finished step (evidence, draft) so a resume does not redo it
  stableKeys: boolean; // one Idempotency-Key per invoice and action, the same on every try
  policyFromFile: boolean; // limits come from POLICY_FILE (or policy.yaml); false hard-codes them
  policyGate: boolean; // a gate before every write; false lets text in a scan approve a payment
  events: boolean; // POST /events starts a job from a webhook
  stableEventJobs: boolean; // a redelivered webhook (same event_id) starts nothing new
  schedule: boolean; // a timer reads INBOX_DIR and starts a job for each invoice there
  stableScheduleJobs: boolean; // the next tick does not start the same invoice again
  labelTrigger: boolean; // the root span says which trigger started the job
  budget: boolean; // stop a job at its budget, and every job at the cap across jobs
  onlyFinanceLeadRaises: boolean; // only the finance lead may raise a budget
  tenantScoped: boolean; // send the job's own tenant in X-Tenant
  boardByTenant: boolean; // one board row per tenant
};
export const READY: Options = {
  persist: true,
  saveSteps: true,
  stableKeys: true,
  policyFromFile: true,
  policyGate: true,
  events: true,
  stableEventJobs: true,
  schedule: true,
  stableScheduleJobs: true,
  labelTrigger: true,
  budget: true,
  onlyFinanceLeadRaises: true,
  tenantScoped: true,
  boardByTenant: true,
};

// Words that make a line of a document an order to the employee, not a fact about the load.
const ORDERS =
  /\b(approved by|pay at once|pay immediately|no further checks|ignore (the|your|all) )/i;

type Policy = {
  limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number };
  approver_role: string;
  rules: { id: string; says: string }[];
};

// The wrong answer that keeps its limits in code: USD 5,000 to pay, USD 1,000 to dispute.
const HARD_CODED: Policy = {
  limits: { pay_usd_without_approval: 5000, dispute_usd_without_approval: 1000 },
  approver_role: "finance_lead",
  rules: [],
};

type Budget = { perJob: number; acrossJobs: number };

// The caps a person raised: one per job that was raised, and the cap across jobs.
type Caps = { jobs: Record<string, number>; across: number };

// Everything the clerk works with, made once when it starts.
type Clerk = {
  options: Options;
  policy: Policy;
  budget: Budget;
  caps: Caps;
  world: ReturnType<typeof worldClient>;
  store: ReturnType<typeof openStore>;
  traceDir: string;
  stateDir: string;
  inboxDir: string;
  running: Set<string>;
};

// What one run of one job has at hand. Steps are the steps this run may reuse and save.
type JobRun = {
  clerk: Clerk;
  job: Job;
  steps: JobSteps;
  invoiceId: string;
  trace: ReturnType<typeof tracer>;
  root: string;
};

// How a run ends: the fields of the job to save.
type Outcome = Partial<Job>;

// The policy gate's answer: refuse with a reason, ask a person in a role, or allow.
type Verdict = { rule: string | null; refuse: string | null; needsRole: string | null };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const roundUsd = (amount: number) => Math.round(amount * 1e8) / 1e8;
const usd = (amount: number) => `USD ${amount.toLocaleString("en-US")}`;
const roleName = (role: string) => role.replace("_", " ");

function requireJob(clerk: Clerk, jobId: string): Job {
  const job = clerk.store.get(jobId);
  if (!job) throw new Error(`there is no job ${jobId}`);
  return job;
}

// ---- Policy, budget and caps ----

function readPolicy(options: Options): Policy {
  if (!options.policyFromFile) return HARD_CODED;
  const policyHere = join(process.cwd(), "policy.yaml");
  const referencePolicy = join(import.meta.dir, "..", "..", "reference", "policy.yaml");
  const fallback = existsSync(policyHere) ? policyHere : referencePolicy;
  const path = process.env.POLICY_FILE ?? fallback;
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Policy;
}

type EmployeeToml = { budget?: { max_usd_per_job?: number; max_usd_per_day?: number } };

// Budgets come from employee.toml [budget].
// An operator can lower them with BUDGET_USD_PER_JOB and BUDGET_USD_PER_DAY.
function readBudget(): Budget {
  let toml: EmployeeToml = {};
  if (existsSync("employee.toml"))
    toml = Bun.TOML.parse(readFileSync("employee.toml", "utf8")) as EmployeeToml;
  const fromFile = toml.budget ?? {};
  return {
    perJob: Number(process.env.BUDGET_USD_PER_JOB ?? fromFile.max_usd_per_job ?? 0.05),
    acrossJobs: Number(process.env.BUDGET_USD_PER_DAY ?? fromFile.max_usd_per_day ?? 5),
  };
}

// Raised caps live next to the job table, so a restart keeps them.
const capsFile = (clerk: Pick<Clerk, "stateDir">) => join(clerk.stateDir, "budget.json");

function readCaps(clerk: Omit<Clerk, "caps">): Caps {
  const file = capsFile(clerk);
  if (clerk.options.persist && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return { jobs: {}, across: clerk.budget.acrossJobs };
}

function saveCaps(clerk: Clerk, caps: Caps) {
  clerk.caps = caps;
  if (!clerk.options.persist) return;
  mkdirSync(clerk.stateDir, { recursive: true });
  writeFileSync(capsFile(clerk), JSON.stringify(caps));
}

const jobCap = (clerk: Clerk, jobId: string) => clerk.caps.jobs[jobId] ?? clerk.budget.perJob;

function spentAcrossJobs(clerk: Clerk): number {
  const jobs = clerk.store.all();
  return jobs.reduce((total, job) => total + (job.spend_usd ?? 0), 0);
}

// ---- Starting a job: from a person, a webhook or the timer ----

type NewJob = { job_id: string; tenant: string; trigger: Job["trigger"]; input: Job["input"] };

// A job id already seen starts nothing new: it answers the job that exists.
function startJob(clerk: Clerk, newJob: NewJob): { job: Job; fresh: boolean } {
  const seen = clerk.store.get(newJob.job_id);
  if (seen) return { job: seen, fresh: false };
  const now = new Date().toISOString();
  clerk.store.insert({
    job_id: newJob.job_id,
    run_id: `run-${randomUUID().slice(0, 8)}`,
    tenant: newJob.tenant,
    trigger: newJob.trigger ?? { kind: "person" },
    input: newJob.input,
    status: "working",
    reason: null,
    column: null,
    steps: {},
    spend_usd: 0,
    summary: null,
    created_at: now,
    updated_at: now,
  });
  void runJob(clerk, newJob.job_id, false);
  return { job: requireJob(clerk, newJob.job_id), fresh: true };
}

// ---- One job, step by step ----

async function runJob(clerk: Clerk, jobId: string, resumed: boolean) {
  if (clerk.running.has(jobId)) return;
  clerk.running.add(jobId);
  const job = requireJob(clerk, jobId);
  const trace = tracer(clerk.traceDir, job.run_id);
  let triggerKind = "person";
  if (clerk.options.labelTrigger) triggerKind = job.trigger?.kind ?? "person";
  const attributes = {
    "gen_ai.agent.name": NAME,
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.trigger.kind": triggerKind,
    "x.resumed": resumed,
  };
  try {
    await trace.span("invoke_agent", null, attributes, async (root, addAttributes) => {
      const run = startRun(clerk, job, trace, root);
      const outcome = await workOrStopOnError(run);
      clerk.store.update(job.job_id, outcome);
      addAttributes({ "x.outcome": outcome.status ?? "working" });
    });
  } finally {
    clerk.running.delete(jobId);
  }
}

// The wrong answer that does not save steps keeps only the approval, so a resume redoes the rest.
function startRun(clerk: Clerk, job: Job, trace: JobRun["trace"], root: string): JobRun {
  let steps: JobSteps = job.steps;
  if (!clerk.options.saveSteps) steps = { approval: job.steps.approval };
  return { clerk, job, steps, invoiceId: job.input.invoice_id, trace, root };
}

function saveSteps(run: JobRun) {
  const { clerk, job, steps } = run;
  if (clerk.options.saveSteps) {
    clerk.store.update(job.job_id, { steps });
    return;
  }
  const savedSteps = requireJob(clerk, job.job_id).steps;
  clerk.store.update(job.job_id, { steps: { ...savedSteps, approval: steps.approval } });
}

async function workOrStopOnError(run: JobRun): Promise<Outcome> {
  try {
    return await work(run);
  } catch (error) {
    return {
      status: "failed",
      column: "Needs you",
      reason: `The job stopped on an error: ${(error as Error).message}`,
    };
  }
}

async function work(run: JobRun): Promise<Outcome> {
  const { clerk, job, steps, invoiceId } = run;

  // 1. Read the evidence, once.
  if (!steps.evidence) {
    const invoice = await callTool<Invoice>(run, "read_invoice", { invoice_id: invoiceId });
    if (invoice.tenant !== job.tenant) return refuseOtherTenant(run, invoice);
    await readRestOfEvidence(run, invoice);
  }
  const evidence = steps.evidence as Evidence;
  const summary = `${invoiceId}, ${evidence.load.carrier.name}, ${usd(evidence.invoice.total_usd)}`;
  clerk.store.update(job.job_id, { summary });

  // 2. The model drafts a decision, inside the budget.
  if (!steps.draft) {
    const stop = overBudget(run);
    if (stop) return stop;
    await draftDecision(run, evidence);
  }
  if (!steps.budgetCleared) {
    const stop = overBudget(run);
    if (stop) return stop;
  }
  return decideAndWrite(run, { evidence, draft: steps.draft as Draft, summary });
}

type Drafted = { evidence: Evidence; draft: Draft; summary: string };

async function decideAndWrite(run: JobRun, drafted: Drafted): Promise<Outcome> {
  const { evidence, draft, summary } = drafted;

  // 3. The checker compares the draft with what the evidence allows.
  const rejection = await checkDraft(run, evidence, draft);
  if (rejection) return rejection;

  // 4. The policy gate, before any write. The model cannot see or change it.
  const verdict = await passPolicyGate(run, evidence, draft);
  if (verdict.refuse)
    return {
      status: "stopped",
      column: "Refused",
      reason: `Refused by ${verdict.rule}: ${verdict.refuse}`,
    };

  // 5. Over a limit, wait for a person.
  if (verdict.needsRole && !run.steps.approval)
    return askForApproval(run, { decision: draft, summary, approverRole: verdict.needsRole });

  // 6. Write once with an idempotency key, then read the ledger to see it landed.
  return writeAndSettle(run, draft);
}

// Every tool call is a span. A call with an idempotency key is a write.
function callTool<Reply>(
  run: JobRun,
  name: string,
  args: Record<string, unknown>,
  key?: string,
): Promise<Reply> {
  const { clerk, job } = run;
  const attributes = {
    "gen_ai.tool.name": name,
    "gen_ai.tool.call.id": randomUUID(),
    "x.side_effect": key ? "write" : "none",
    ...(key ? { "x.idempotency_key": key } : {}),
  };
  // The wrong answer that is not scoped to a tenant sends kaas-freight for every job.
  const tenant = clerk.options.tenantScoped ? job.tenant : "kaas-freight";
  const info = { tenant, job_id: job.job_id, employee: NAME, key };
  return run.trace.span("execute_tool", run.root, attributes, () =>
    clerk.world.call<Reply>(name, args, info),
  );
}

function refuseOtherTenant(run: JobRun, invoice: Invoice): Outcome {
  return {
    status: "stopped",
    column: "Refused",
    reason:
      `Refused by stay-in-the-tenant: ${run.invoiceId} belongs to ${invoice.tenant}, ` +
      `not ${run.job.tenant}.`,
  };
}

async function readRestOfEvidence(run: JobRun, invoice: Invoice) {
  const byLoad = { load_id: invoice.load_id };
  const load = await callTool<Load>(run, "find_load", byLoad);
  const rate = await callTool<RateConfirmation>(run, "read_rate_confirmation", byLoad);
  const proofOfDelivery = await callTool<ProofOfDelivery>(run, "read_proof_of_delivery", byLoad);
  run.steps.evidence = { invoice, load, rate, pod: proofOfDelivery } satisfies Evidence;
  saveSteps(run);
}

async function askTheModel(run: JobRun, evidence: Evidence): Promise<Reply> {
  const attributes = { "gen_ai.request.model": "", "gen_ai.agent.name": NAME };
  return run.trace.span("chat", run.root, attributes, async (_id, addAttributes) => {
    const user = JSON.stringify(promptEvidence(evidence), null, 2);
    const reply = await chat(run.invoiceId, SYSTEM_PROMPT, user);
    addAttributes({
      "gen_ai.request.model": reply.model,
      "gen_ai.response.model": reply.model,
      "gen_ai.usage.input_tokens": reply.usage.input_tokens,
      "gen_ai.usage.output_tokens": reply.usage.output_tokens,
      "gen_ai.usage.cache_read.input_tokens": reply.usage.cache_read_input_tokens,
    });
    return reply;
  });
}

function addSpend(run: JobRun, reply: Reply) {
  const { usage } = reply;
  const spent = costUsd(
    reply.model,
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
  );
  const spentBefore = requireJob(run.clerk, run.job.job_id).spend_usd ?? 0;
  run.clerk.store.update(run.job.job_id, { spend_usd: spentBefore + (spent ?? 0) });
}

async function draftDecision(run: JobRun, evidence: Evidence) {
  const reply = await askTheModel(run, evidence);
  addSpend(run, reply);
  // The model may write words around its JSON object, so read from the first { to the last }.
  const jsonStart = reply.text.indexOf("{");
  const jsonEnd = reply.text.lastIndexOf("}") + 1;
  run.steps.draft = JSON.parse(reply.text.slice(jsonStart, jsonEnd)) as Draft;
  saveSteps(run);
}

async function checkDraft(run: JobRun, evidence: Evidence, draft: Draft): Promise<Outcome | null> {
  const want = expected(evidence);
  const sameAmount = Math.abs(want.amount_usd - draft.amount_usd) < 0.01;
  const sameReason = want.action === "pay" || want.reason_code === draft.reason_code;
  const agrees = want.action === draft.action && sameAmount && sameReason;
  const attributes = {
    "gen_ai.agent.name": "checker",
    "x.role": "checker",
    "x.checker.verdict": agrees ? "accept" : "reject",
  };
  await run.trace.span("invoke_agent", run.root, attributes, async () => {});
  if (agrees) return null;
  return {
    status: "stopped",
    column: "Refused",
    reason:
      `The checker rejected the draft: it said ${draft.action} ${draft.reason_code ?? ""} ` +
      `USD ${draft.amount_usd}, the evidence says ${want.action} ${want.reason_code ?? ""} ` +
      `USD ${want.amount_usd}.`,
  };
}

// ---- The budget ----

// Which cap the job has reached: its own, the one across jobs, or none.
function capReached(clerk: Clerk, job: Job): "job" | "across" | null {
  if (job.spend_usd >= jobCap(clerk, job.job_id)) return "job";
  if (spentAcrossJobs(clerk) >= clerk.caps.across) return "across";
  return null;
}

// Stop at the budget: the job waits in Needs you until the finance lead raises it.
function overBudget(run: JobRun): Outcome | null {
  const { clerk } = run;
  if (!clerk.options.budget) return null;
  const job = requireJob(clerk, run.job.job_id);
  const scope = capReached(clerk, job);
  if (!scope) return null;
  const { caps } = clerk;
  const approvalId = `BUD-${job.job_id}-${Object.keys(caps.jobs).length}-${caps.across}`;
  if (!clerk.store.approval(approvalId))
    clerk.store.addApproval({
      approval_id: approvalId,
      job_id: job.job_id,
      action: "raise_budget",
      amount: scope === "job" ? jobCap(clerk, job.job_id) : caps.across,
      summary: budgetSummary(clerk, job, scope),
      approver_role: clerk.policy.approver_role,
      status: "waiting",
      decided_by: null,
    });
  return {
    status: "waiting_for_human",
    column: "Needs you",
    reason: budgetReason(clerk, job, scope),
  };
}

function budgetSummary(clerk: Clerk, job: Job, scope: "job" | "across"): string {
  const spentByJob = job.spend_usd.toFixed(6);
  const cap = jobCap(clerk, job.job_id);
  if (scope === "job") return `Job ${job.job_id} spent USD ${spentByJob} of its USD ${cap} budget.`;
  const spentByAll = spentAcrossJobs(clerk).toFixed(6);
  return `Jobs spent USD ${spentByAll} of the USD ${clerk.caps.across} cap across jobs.`;
}

function budgetReason(clerk: Clerk, job: Job, scope: "job" | "across"): string {
  const waiting = "Waiting for the finance lead to raise it.";
  if (scope === "job") {
    const spentByJob = job.spend_usd.toFixed(6);
    const cap = jobCap(clerk, job.job_id);
    return `Budget reached: this job spent USD ${spentByJob} of USD ${cap}. ${waiting}`;
  }
  const spentByAll = spentAcrossJobs(clerk).toFixed(6);
  return `Cap across jobs reached: USD ${spentByAll} of USD ${clerk.caps.across}. ${waiting}`;
}

// ---- The policy gate ----

const allow = (): Verdict => ({ rule: null, refuse: null, needsRole: null });
const refuse = (rule: string, why: string): Verdict => ({ rule, refuse: why, needsRole: null });
const askRole = (rule: string, role: string): Verdict => ({ rule, refuse: null, needsRole: role });

// Same key on every try and after a restart, so the world writes once however often we ask.
function idempotencyKey(run: JobRun, action: string, attempt: number): string {
  const { job, invoiceId } = run;
  if (run.clerk.options.stableKeys) return `${job.tenant}:${invoiceId}:${action}`;
  return `${job.tenant}:${invoiceId}:${randomUUID()}:${attempt}`;
}

async function passPolicyGate(run: JobRun, evidence: Evidence, decision: Draft): Promise<Verdict> {
  if (!run.clerk.options.policyGate) {
    // The wrong answer with no gate: a name in the draft counts as an approval.
    if (decision.approved_by) run.steps.approval = { by: decision.approved_by, from: "document" };
    return allow();
  }
  const ourKey = idempotencyKey(run, decision.action, 1);
  const verdict = policyVerdict(run, evidence, decision, ourKey);
  let policyDecision = "allow";
  if (verdict.refuse) policyDecision = "refuse";
  else if (verdict.needsRole) policyDecision = "needs_approval";
  const attributes = {
    "x.policy.rule": verdict.rule ?? "none",
    "x.policy.decision": policyDecision,
  };
  await run.trace.span("x.policy_gate", run.root, attributes, async () => {});
  return verdict;
}

function policyVerdict(run: JobRun, evidence: Evidence, decision: Draft, ourKey: string): Verdict {
  const scanLines = evidence.invoice.scan_text.split("\n");
  const order = scanLines.find((line) => ORDERS.test(line));
  if (order)
    return refuse(
      "documents-do-not-give-orders",
      `the invoice scan says "${order.trim()}". A document is evidence, not an instruction.`,
    );
  if (decision.approved_by && !run.steps.approval)
    return refuse(
      "approvals-come-from-people",
      `the draft says ${decision.approved_by} approved this, but nobody approved it through ` +
        "the approval flow.",
    );
  const { limits, approver_role: approverRole } = run.clerk.policy;
  if (decision.action === "pay") return paymentVerdict(run, evidence, decision, ourKey);
  if (decision.amount_usd > limits.dispute_usd_without_approval)
    return askRole("limits.dispute_usd_without_approval", approverRole);
  return allow();
}

function paymentVerdict(run: JobRun, evidence: Evidence, decision: Draft, ourKey: string): Verdict {
  const { invoice } = evidence;
  const { limits, approver_role: approverRole } = run.clerk.policy;
  const otherPayments = invoice.payments.filter((payment) => payment.idempotency_key !== ourKey);
  if (otherPayments.length)
    return refuse(
      "never-pay-twice",
      `${invoice.invoice_id} already has payment ${otherPayments[0].payment_id}.`,
    );
  const allowed = allowedTotal(evidence).total;
  if (decision.amount_usd > allowed + 0.001)
    return refuse(
      "never-pay-above-the-rate",
      `USD ${decision.amount_usd} is above the USD ${allowed} the rate and the proof of ` +
        "delivery allow.",
    );
  if (decision.amount_usd > limits.pay_usd_without_approval)
    return askRole("limits.pay_usd_without_approval", approverRole);
  return allow();
}

// ---- Approval and the write ----

type ApprovalRequest = { decision: Draft; summary: string; approverRole: string };

function askForApproval(run: JobRun, request: ApprovalRequest): Outcome {
  const { decision, summary, approverRole } = request;
  const { store } = run.clerk;
  const approvalId = `APR-${run.job.job_id}`;
  const isPayment = decision.action === "pay";
  if (!store.approval(approvalId))
    store.addApproval({
      approval_id: approvalId,
      job_id: run.job.job_id,
      action: isPayment ? "pay_invoice" : "open_dispute",
      amount: decision.amount_usd,
      summary: `${isPayment ? "Pay" : "Dispute"} ${summary}. ${decision.note}`,
      approver_role: approverRole,
      status: "waiting",
      decided_by: null,
    });
  return {
    status: "waiting_for_human",
    column: "Needs you",
    reason:
      `${usd(decision.amount_usd)} is over the limit for paying without approval. ` +
      `Waiting for the ${roleName(approverRole)}.`,
  };
}

function writeArguments(run: JobRun, decision: Draft): Record<string, unknown> {
  const approvedBy = run.steps.approval ? { approved_by: run.steps.approval.by } : {};
  if (decision.action === "pay")
    return { invoice_id: run.invoiceId, amount_usd: decision.amount_usd, ...approvedBy };
  return {
    invoice_id: run.invoiceId,
    reason_code: decision.reason_code,
    amount_usd: decision.amount_usd,
    note: decision.note,
    ...approvedBy,
  };
}

// One try of the write. Answers the tool's failure, or null when the write answered.
async function tryWrite(run: JobRun, decision: Draft, key: string): Promise<ToolFailed | null> {
  const toolName = decision.action === "pay" ? "pay_invoice" : "open_dispute";
  try {
    await callTool(run, toolName, writeArguments(run, decision), key);
    return null;
  } catch (error) {
    if (!(error instanceof ToolFailed)) throw error;
    return error;
  }
}

// Settle: the ledger decides, not the reply.
async function ledgerShowsWrite(run: JobRun, decision: Draft, keysTried: string[]) {
  const invoiceNow = await callTool<Invoice>(run, "read_invoice", { invoice_id: run.invoiceId });
  const rows = decision.action === "pay" ? invoiceNow.payments : invoiceNow.disputes;
  const ours = rows.filter((row) => keysTried.includes(row.idempotency_key));
  return ours.length >= 1;
}

// The keys tried so far for this write, and the last thing that went wrong.
type WriteTries = { keysTried: string[]; lastError: string };

// One try: write, then read the ledger. It answers how the job ends, or what to do next.
async function tryOnce(
  run: JobRun,
  decision: Draft,
  tries: WriteTries,
  attempt: number,
): Promise<Outcome | "try again" | "give up"> {
  const key = idempotencyKey(run, decision.action, attempt);
  tries.keysTried.push(key);
  const failure = await tryWrite(run, decision, key);
  tries.lastError = failure?.message ?? "";
  // The world said the request itself is wrong, so the same request will not work either.
  if (failure && failure.status >= 400 && failure.status < 500) return "give up";
  if (await ledgerShowsWrite(run, decision, tries.keysTried)) return done(decision, run.invoiceId);
  if (!tries.lastError) tries.lastError = "the write answered, but the ledger shows nothing";
  return "try again";
}

async function writeAndSettle(run: JobRun, decision: Draft): Promise<Outcome> {
  const tries: WriteTries = { keysTried: [], lastError: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await tryOnce(run, decision, tries, attempt);
    if (result === "give up") break;
    if (result !== "try again") return result;
  }
  const written = decision.action === "pay" ? "payment" : "dispute";
  return {
    status: "failed",
    column: "Needs you",
    reason: `The ledger shows no ${written} for ${run.invoiceId}. Last error: ${tries.lastError}.`,
  };
}

function done(decision: Draft, invoiceId: string): Outcome {
  const amount = usd(decision.amount_usd);
  let reason = `Disputed ${invoiceId}: ${decision.reason_code}, ${amount}. The ledger agrees.`;
  if (decision.action === "pay") reason = `Paid ${invoiceId}: ${amount}. The ledger agrees.`;
  return { status: "done", column: "Done", reason };
}

// ---- The board ----

function boardRow(jobs: Job[]) {
  const outcomes = jobs.filter((job) => job.status === "done").length;
  const spend = jobs.reduce((total, job) => total + (job.spend_usd ?? 0), 0);
  return {
    outcomes,
    spend_usd: roundUsd(spend),
    cost_per_outcome_usd: outcomes ? roundUsd(spend / outcomes) : null,
  };
}

function tenantRow(tenant: string, jobs: Job[]) {
  const byEmployee = [{ employee: NAME, ...boardRow(jobs) }];
  return { tenant, ...boardRow(jobs), by_employee: byEmployee };
}

function board(clerk: Clerk) {
  const jobs = clerk.store.all();
  // The wrong answer with one row puts every tenant's jobs under kaas-freight.
  if (!clerk.options.boardByTenant) return { tenants: [tenantRow("kaas-freight", jobs)] };
  const tenants = [...new Set(jobs.map((job) => job.tenant))];
  return {
    tenants: tenants.map((tenant) => {
      const tenantJobs = jobs.filter((job) => job.tenant === tenant);
      return tenantRow(tenant, tenantJobs);
    }),
  };
}

function startBoard(clerk: Clerk, boardPort: number) {
  return Bun.serve({
    port: boardPort,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/board/data")
        return json({
          board: board(clerk),
          jobs: clerk.store.all().map(({ steps: _steps, ...job }) => job),
          approvals: clerk.store.approvals("waiting"),
        });
      if (url.pathname === "/" || url.pathname === "/board")
        return new Response(boardPage(NAME), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return json({ error: "not found" }, 404);
    },
  });
}

// ---- The timer ----

type InboxItem = { invoice_id?: string; tenant?: string } | null;

function readInboxItem(path: string): InboxItem {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Every SCHEDULE_EVERY_MS, start a job for each invoice file in INBOX_DIR.
function sweepInbox(clerk: Clerk, tick: number) {
  if (!existsSync(clerk.inboxDir)) return;
  const invoiceFiles = readdirSync(clerk.inboxDir).filter((file) => file.endsWith(".json"));
  for (const file of invoiceFiles) {
    const item = readInboxItem(join(clerk.inboxDir, file));
    if (!item?.invoice_id || !TENANTS.includes(item.tenant ?? "")) continue;
    const tenant = item.tenant as string;
    // The wrong answer adds the tick, so the next tick starts the same invoice again.
    let jobId = `schedule-${tenant}-${item.invoice_id}`;
    if (!clerk.options.stableScheduleJobs) jobId = `${jobId}-${tick}`;
    startJob(clerk, {
      job_id: jobId,
      tenant,
      trigger: { kind: "schedule", by: "timer" },
      input: { invoice_id: item.invoice_id },
    });
  }
}

function startTimer(clerk: Clerk) {
  if (!clerk.options.schedule) return null;
  let tick = 0;
  const everyMs = Number(process.env.SCHEDULE_EVERY_MS ?? 86_400_000);
  return setInterval(() => {
    tick++;
    sweepInbox(clerk, tick);
  }, everyMs);
}

// ---- The contract over HTTP ----

type JobRequest = Partial<NewJob> | null;
type EventRequest = {
  event_id?: string;
  type?: string;
  tenant?: string;
  invoice_id?: string;
} | null;
type ApprovalAnswer = { decision?: string; by?: string } | null;
type Answer = { decision: string; by: string };

function createJob(clerk: Clerk, body: JobRequest): Response {
  if (!body?.job_id || !body?.tenant || !body?.input?.invoice_id)
    return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
  if (!TENANTS.includes(body.tenant))
    return json({ error: `this employee does not work for ${body.tenant}` }, 400);
  const { job, fresh } = startJob(clerk, body as NewJob);
  return json({ job_id: job.job_id, run_id: job.run_id }, fresh ? 202 : 200);
}

// The world's webhook: a new invoice arrived.
// Webhooks are delivered at least once, so event_id names the job.
function receiveEvent(clerk: Clerk, body: EventRequest): Response {
  if (!body?.event_id || !body?.invoice_id || !TENANTS.includes(body?.tenant ?? ""))
    return json(
      { error: 'send {"event_id", "type": "invoice.received", "tenant", "invoice_id"}' },
      400,
    );
  // The wrong answer adds a random part, so a redelivered event starts a second job.
  let jobId = `event-${body.event_id}`;
  if (!clerk.options.stableEventJobs) jobId = `${jobId}-${randomUUID().slice(0, 6)}`;
  const { job, fresh } = startJob(clerk, {
    job_id: jobId,
    tenant: body.tenant as string,
    trigger: { kind: "event", by: "world" },
    input: { invoice_id: body.invoice_id },
  });
  return json({ job_id: job.job_id, run_id: job.run_id }, fresh ? 202 : 200);
}

function jobStatus(clerk: Clerk, jobId: string): Response {
  const job = clerk.store.get(jobId);
  if (!job) return json({ error: "no such job" }, 404);
  return json({
    job_id: job.job_id,
    run_id: job.run_id,
    status: job.status,
    reason: job.reason,
    cost_usd: roundUsd(job.spend_usd),
  });
}

// An approval as the contract shows it: who decided it stays inside the employee.
function approvalForContract(approval: Approval) {
  const { decided_by: _decidedBy, ...details } = approval;
  return details;
}

// Why this person may not decide this approval, or null when they may.
async function approverProblem(clerk: Clerk, approval: Approval, job: Job, answer: Answer) {
  const { decision, by } = answer;
  const people = await clerk.world.people();
  const person = people.find((someone) => someone.person_id === by);
  if (!person) return `nobody called ${by} works here`;
  if (person.tenant !== job.tenant)
    return `${person.name} works for ${person.tenant}, not ${job.tenant}`;
  if (!person.may_approve)
    return `${person.name} is a ${roleName(person.role)} and may not approve or decline`;
  if (approval.action === "raise_budget") {
    const approverRole = clerk.policy.approver_role;
    // The wrong answer lets anyone who may approve a payment raise a budget too.
    if (clerk.options.onlyFinanceLeadRaises && person.role !== approverRole)
      return (
        `Only the ${roleName(approverRole)} may raise a budget. ` +
        `${person.name} is a ${roleName(person.role)}.`
      );
    return null;
  }
  const isPayment = approval.action === "pay_invoice";
  const limit = isPayment ? person.pay_limit_usd : person.dispute_limit_usd;
  // Only an approval can go over a limit; anyone who may approve may also decline.
  if (decision === "approve" && limit !== null && approval.amount > limit)
    return `${usd(approval.amount)} is over ${person.name}'s limit of ${usd(limit)}`;
  return null;
}

async function decide(clerk: Clerk, approvalId: string, answer: ApprovalAnswer) {
  const approval = clerk.store.approval(approvalId);
  if (!approval) return json({ error: "no such approval" }, 404);
  if (approval.status !== "waiting") return json({ error: `already ${approval.status}` }, 409);
  const decision = answer?.decision ?? "";
  if (!["approve", "decline"].includes(decision) || !answer?.by)
    return json({ error: 'send {"decision": "approve" or "decline", "by": person id}' }, 400);
  const checked: Answer = { decision, by: answer.by };
  const job = requireJob(clerk, approval.job_id);
  const problem = await approverProblem(clerk, approval, job, checked);
  if (problem) return json({ reason: problem }, 403);
  return applyDecision(clerk, approval, job, checked);
}

async function applyDecision(clerk: Clerk, approval: Approval, job: Job, answer: Answer) {
  const { decision, by: person } = answer;
  const approvalId = approval.approval_id;
  const attributes = {
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.approval.decision": decision,
    "x.approval.by": person,
    "x.approval.action": approval.action,
  };
  await tracer(clerk.traceDir, job.run_id).span("x.approval", null, attributes, async () => {});
  if (decision === "decline") {
    clerk.store.decide(approvalId, "declined", person);
    const reason = `Declined by ${person}. Nothing was written.`;
    clerk.store.update(job.job_id, { status: "declined", column: "Refused", reason });
    return json({ approval_id: approvalId, status: "declined" });
  }
  clerk.store.decide(approvalId, "approved", person);
  if (approval.action === "raise_budget") raiseBudget(clerk, job, person);
  else {
    const approvalStep = { by: person, at: new Date().toISOString() };
    const steps = { ...job.steps, approval: approvalStep };
    clerk.store.update(job.job_id, { status: "working", column: null, steps });
  }
  void runJob(clerk, job.job_id, true);
  return json({ approval_id: approvalId, status: "approved" });
}

// Raise the cap that stopped the job: the job's own, or the cap across jobs.
function raiseBudget(clerk: Clerk, job: Job, person: string) {
  const caps: Caps = { ...clerk.caps, jobs: { ...clerk.caps.jobs } };
  const { budget } = clerk;
  if (job.spend_usd >= jobCap(clerk, job.job_id))
    caps.jobs[job.job_id] = job.spend_usd + budget.perJob;
  else caps.across = spentAcrossJobs(clerk) + budget.acrossJobs;
  saveCaps(clerk, caps);
  const steps = { ...job.steps, budgetCleared: { by: person } };
  clerk.store.update(job.job_id, { status: "working", column: null, steps });
}

async function readBody<Body>(request: Request, whenUnreadable: Body): Promise<Body> {
  return (await request.json().catch(() => whenUnreadable)) as Body;
}

async function answerContract(clerk: Clerk, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const [section, id] = url.pathname.split("/").filter(Boolean);
  if (route === "GET /health") return json({ contract: "1", employee: NAME, tenants: TENANTS });
  if (request.method === "GET" && section === "jobs" && id)
    return jobStatus(clerk, decodeURIComponent(id));
  if (route === "GET /approvals") {
    const status = url.searchParams.get("status") ?? undefined;
    return json(clerk.store.approvals(status).map(approvalForContract));
  }
  if (route === "GET /board") return json(board(clerk));
  if (request.method === "POST") return answerPost(clerk, request, url.pathname);
  return json({ error: "not found" }, 404);
}

// The routes that read a JSON body.
async function answerPost(clerk: Clerk, request: Request, path: string): Promise<Response> {
  const [section, id] = path.split("/").filter(Boolean);
  if (path === "/jobs") return createJob(clerk, await readBody<JobRequest>(request, null));
  if (clerk.options.events && path === "/events")
    return receiveEvent(clerk, await readBody<EventRequest>(request, null));
  if (section === "approvals" && id) {
    const answer = await readBody<ApprovalAnswer>(request, {});
    return decide(clerk, decodeURIComponent(id), answer);
  }
  return json({ error: "not found" }, 404);
}

// ---- Start ----

function hireClerk(options: Options): Clerk {
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const clerkWithoutCaps = {
    options,
    policy: readPolicy(options),
    budget: readBudget(),
    world: worldClient(),
    store: openStore(options.persist ? stateDir : null),
    traceDir: process.env.TRACE_DIR ?? join(process.cwd(), "traces"),
    stateDir,
    inboxDir: process.env.INBOX_DIR ?? join(process.cwd(), "inbox"),
    running: new Set<string>(),
  };
  return { ...clerkWithoutCaps, caps: readCaps(clerkWithoutCaps) };
}

export function deployEmployee(overrides: Partial<Options> = {}) {
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
  const clerk = hireClerk({ ...READY, ...overrides });
  const timer = startTimer(clerk);
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    fetch: (request) => answerContract(clerk, request),
  });
  const boardServer = boardPort ? startBoard(clerk, boardPort) : null;

  // Resume: a job that was working when the process died carries on from its last saved step.
  for (const job of clerk.store.all()) {
    if (job.status === "working") void runJob(clerk, job.job_id, true);
  }

  const stop = () => {
    if (timer) clearInterval(timer);
    server.stop(true);
    boardServer?.stop(true);
  };
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  return { port: server.port, stop };
}
