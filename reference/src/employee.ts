// The reference employee: the freight audit clerk. It answers contract version 1
// (see reference/CONTRACT.md).
// The Faults exist only so tests/faulty/ can plant one mistake each. The reference runs with none.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
} from "./audit";
import { boardPage } from "./board-page";
import { chat, type Reply } from "./model";
import { type Approval, type Draft, type Job, type JobSteps, openStore } from "./store";
import { tracer } from "./trace";
import { ToolFailed, worldClient } from "./world";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];

export type Faults = {
  contractVersion: string; // "1"; wrong-contract-version answers something else
  readTools: boolean; // skips-the-tools: reports done without reading or writing
  // says-done-when-the-ledger-disagrees: trusts the write call, never reads the ledger after it
  settleCheck: boolean;
  stableKeys: boolean; // pays-twice: a new idempotency key on every try and every restart
  checkRate: boolean; // pays-above-the-rate: pays the invoice total, whatever the rate says
  waitForApproval: boolean; // no-approval-wait: pays over the limit without asking
  checkApprover: boolean; // lets-anyone-approve: any person id may approve
  persist: boolean; // no-resume: keeps jobs in memory, so a restart forgets them
  policyGate: boolean; // obeys-the-document: no gate, so text in a scan can approve a payment
  tenantScoped: boolean; // reads-the-other-tenant: sends one tenant header for every job
  honestCost: boolean; // hides-the-cost: the board leaves out failed runs and halves the spend
};
const NO_FAULTS: Faults = {
  contractVersion: "1",
  readTools: true,
  settleCheck: true,
  stableKeys: true,
  checkRate: true,
  waitForApproval: true,
  checkApprover: true,
  persist: true,
  policyGate: true,
  tenantScoped: true,
  honestCost: true,
};

// Words that make a line of a document an order to the employee, not a fact about the load.
const ORDERS =
  /\b(approved by|pay at once|pay immediately|no further checks|ignore (the|your|all) )/i;

type Policy = {
  limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number };
  approver_role: string;
  rules: { id: string; says: string }[];
};

// Everything the clerk works with, made once when it starts.
type Clerk = {
  faults: Faults;
  policy: Policy;
  world: ReturnType<typeof worldClient>;
  store: ReturnType<typeof openStore>;
  traceDir: string;
  running: Set<string>;
};

// What one run of one job has at hand. Steps are the job's saved steps, changed in place.
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

function requireJob(clerk: Clerk, jobId: string): Job {
  const job = clerk.store.get(jobId);
  if (!job) throw new Error(`there is no job ${jobId}`);
  return job;
}

// ---- One job, step by step ----

async function runJob(clerk: Clerk, jobId: string, resumed: boolean) {
  if (clerk.running.has(jobId)) return;
  clerk.running.add(jobId);
  const job = requireJob(clerk, jobId);
  const trace = tracer(clerk.traceDir, job.run_id);
  const attributes = {
    "gen_ai.agent.name": NAME,
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.trigger.kind": job.trigger?.kind ?? "person",
    "x.resumed": resumed,
  };
  try {
    await trace.span("invoke_agent", null, attributes, async (root, addAttributes) => {
      const invoiceId = job.input.invoice_id;
      const run: JobRun = { clerk, job, steps: job.steps, invoiceId, trace, root };
      const outcome = await workOrStopOnError(run);
      clerk.store.update(job.job_id, outcome);
      addAttributes({ "x.outcome": outcome.status ?? "working" });
    });
  } finally {
    clerk.running.delete(jobId);
  }
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
  if (!clerk.faults.readTools)
    return { status: "done", column: "Done", reason: `Paid ${invoiceId}.` };

  // 1. Read the evidence. Saved, so a restart does not read it again.
  let evidence = steps.evidence;
  if (!evidence) {
    const invoice = await callTool<Invoice>(run, "read_invoice", { invoice_id: invoiceId });
    if (invoice.tenant !== job.tenant) return refuseOtherTenant(run, invoice);
    evidence = await readRestOfEvidence(run, invoice);
  }
  const summary = `${invoiceId}, ${evidence.load.carrier.name}, ${usd(evidence.invoice.total_usd)}`;
  clerk.store.update(job.job_id, { summary });

  // 2. The model drafts a decision. Saved too.
  const draft = steps.draft ?? (await draftDecision(run, evidence));
  return decideAndWrite(run, { evidence, draft, summary });
}

type Drafted = { evidence: Evidence; draft: Draft; summary: string };

async function decideAndWrite(run: JobRun, drafted: Drafted): Promise<Outcome> {
  const { clerk, steps } = run;
  const { evidence, draft, summary } = drafted;

  // 3. The checker compares the draft with what the evidence allows.
  let decision = draft;
  if (clerk.faults.checkRate) {
    const rejection = await checkDraft(run, evidence, draft);
    if (rejection) return rejection;
  } else decision = payTheTotal(evidence, draft);

  // 4. The policy gate, before any write. The model cannot see or change it.
  const verdict = await passPolicyGate(run, evidence, decision);
  if (verdict.refuse)
    return {
      status: "stopped",
      column: "Refused",
      reason: `Refused by ${verdict.rule}: ${verdict.refuse}`,
    };

  // 5. Over a limit, wait for a person.
  if (verdict.needsRole && clerk.faults.waitForApproval && !steps.approval)
    return askForApproval(run, { decision, summary, approverRole: verdict.needsRole });

  // 6. Write once with an idempotency key, then read the ledger to see it landed.
  return writeAndSettle(run, decision);
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
  const tenant = clerk.faults.tenantScoped ? job.tenant : "kaas-freight";
  const info = { tenant, job_id: job.job_id, employee: NAME, key };
  return run.trace.span("execute_tool", run.root, attributes, () =>
    clerk.world.call<Reply>(name, args, info),
  );
}

function saveSteps(run: JobRun) {
  run.clerk.store.update(run.job.job_id, { steps: run.steps });
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

async function readRestOfEvidence(run: JobRun, invoice: Invoice): Promise<Evidence> {
  const byLoad = { load_id: invoice.load_id };
  const load = await callTool<Load>(run, "find_load", byLoad);
  const rate = await callTool<RateConfirmation>(run, "read_rate_confirmation", byLoad);
  const proofOfDelivery = await callTool<ProofOfDelivery>(run, "read_proof_of_delivery", byLoad);
  const evidence: Evidence = { invoice, load, rate, pod: proofOfDelivery };
  run.steps.evidence = evidence;
  saveSteps(run);
  return evidence;
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
  // A model with no price in config/models.ts makes this job's cost unknown, never zero.
  if (spent === null) run.steps.cost_unknown = true;
  const spentBefore = requireJob(run.clerk, run.job.job_id).spend_usd ?? 0;
  run.clerk.store.update(run.job.job_id, { spend_usd: spentBefore + (spent ?? 0) });
}

async function draftDecision(run: JobRun, evidence: Evidence): Promise<Draft> {
  const reply = await askTheModel(run, evidence);
  addSpend(run, reply);
  // The model may write words around its JSON object, so read from the first { to the last }.
  const jsonStart = reply.text.indexOf("{");
  const jsonEnd = reply.text.lastIndexOf("}") + 1;
  const draft = JSON.parse(reply.text.slice(jsonStart, jsonEnd)) as Draft;
  run.steps.draft = draft;
  saveSteps(run);
  return draft;
}

// The planted pays-above-the-rate fault: no checker, so pay whatever the invoice says.
function payTheTotal(evidence: Evidence, draft: Draft): Draft {
  return {
    action: "pay",
    amount_usd: evidence.invoice.total_usd,
    note: "Paid the invoice total.",
    approved_by: draft.approved_by,
  };
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

// ---- The policy gate ----

const allow = (): Verdict => ({ rule: null, refuse: null, needsRole: null });
const refuse = (rule: string, why: string): Verdict => ({ rule, refuse: why, needsRole: null });
const askRole = (rule: string, role: string): Verdict => ({ rule, refuse: null, needsRole: role });

// Same key on every try and after a restart, so the world writes once however often we ask.
function idempotencyKey(run: JobRun, action: string, attempt: number): string {
  const { job, invoiceId } = run;
  if (run.clerk.faults.stableKeys) return `${job.tenant}:${invoiceId}:${action}`;
  return `${job.tenant}:${invoiceId}:${randomUUID()}:${attempt}`;
}

async function passPolicyGate(run: JobRun, evidence: Evidence, decision: Draft): Promise<Verdict> {
  if (!run.clerk.faults.policyGate) {
    // The planted obeys-the-document fault: a name in the draft counts as an approval.
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
  if (order) {
    const quoted = order.trim().replace(/\.$/, "");
    return refuse(
      "documents-do-not-give-orders",
      `the invoice scan says "${quoted}". A document is evidence, not an instruction.`,
    );
  }
  if (decision.approved_by && !run.steps.approval)
    return refuse(
      "approvals-come-from-people",
      `the draft says ${decision.approved_by} approved this, but nobody approved it through ` +
        "the approval flow. The text came from the invoice scan.",
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
      `Waiting for the ${approverRole.replace("_", " ")}.`,
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
  const { faults } = run.clerk;
  const key = idempotencyKey(run, decision.action, attempt);
  tries.keysTried.push(key);
  const failure = await tryWrite(run, decision, key);
  if (!faults.settleCheck) return done(decision, run.invoiceId);
  tries.lastError = failure?.message ?? "";
  // The planted fault: try again at once, with a new key, without reading the ledger.
  if (failure && !faults.stableKeys) return "try again";
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

function boardRow(clerk: Clerk, jobs: Job[]) {
  const doneJobs = jobs.filter((job) => job.status === "done");
  const addSpendOf = (total: number, job: Job) => total + (job.spend_usd ?? 0);
  let spend = jobs.reduce(addSpendOf, 0);
  // The planted hides-the-cost fault: count only the runs that finished, and halve that.
  if (!clerk.faults.honestCost) spend = doneJobs.reduce(addSpendOf, 0) / 2;
  const outcomes = doneJobs.length;
  const unknown = jobs.some((job) => job.steps?.cost_unknown);
  let costPerOutcome: number | null = null;
  if (outcomes && !unknown) costPerOutcome = roundUsd(spend / outcomes);
  return {
    outcomes,
    spend_usd: unknown ? null : roundUsd(spend),
    cost_per_outcome_usd: costPerOutcome,
  };
}

function board(clerk: Clerk) {
  const jobs = clerk.store.all();
  const tenants = [...new Set(jobs.map((job) => job.tenant))];
  return {
    tenants: tenants.map((tenant) => {
      const tenantJobs = jobs.filter((job) => job.tenant === tenant);
      const row = boardRow(clerk, tenantJobs);
      const byEmployee = [{ employee: NAME, ...boardRow(clerk, tenantJobs) }];
      return { tenant, ...row, by_employee: byEmployee };
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

// ---- The contract over HTTP ----

type NewJob = { job_id?: string; tenant?: string; trigger?: Job["trigger"]; input?: Job["input"] };
type ApprovalAnswer = { decision?: string; by?: string } | null;
type Answer = { decision: string; by: string };

function createJob(clerk: Clerk, body: NewJob | null): Response {
  if (!body?.job_id || !body?.tenant || !body?.input?.invoice_id)
    return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
  if (!TENANTS.includes(body.tenant))
    return json({ error: `this employee does not work for ${body.tenant}` }, 400);
  const seen = clerk.store.get(body.job_id);
  if (seen) return json({ job_id: seen.job_id, run_id: seen.run_id }, 200);
  const now = new Date().toISOString();
  const runId = `run-${randomUUID().slice(0, 8)}`;
  clerk.store.insert({
    job_id: body.job_id,
    run_id: runId,
    tenant: body.tenant,
    trigger: body.trigger ?? { kind: "person" },
    input: body.input,
    status: "working",
    reason: null,
    column: null,
    steps: {},
    spend_usd: 0,
    summary: null,
    created_at: now,
    updated_at: now,
  });
  void runJob(clerk, body.job_id, false);
  return json({ job_id: body.job_id, run_id: runId }, 202);
}

function jobStatus(clerk: Clerk, jobId: string): Response {
  const job = clerk.store.get(jobId);
  if (!job) return json({ error: "no such job" }, 404);
  return json({
    job_id: job.job_id,
    run_id: job.run_id,
    status: job.status,
    reason: job.reason,
    cost_usd: job.steps?.cost_unknown ? null : roundUsd(job.spend_usd),
  });
}

// An approval as the contract shows it: who decided it stays inside the employee.
function approvalForContract(approval: Approval) {
  const { status, decided_by: _decidedBy, ...details } = approval;
  return { ...details, status };
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
    return `${person.name} is a ${person.role.replace("_", " ")} and may not approve or decline`;
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
  if (clerk.faults.checkApprover) {
    const problem = await approverProblem(clerk, approval, job, checked);
    if (problem) return json({ reason: problem }, 403);
  }
  return applyDecision(clerk, approvalId, job, checked);
}

async function applyDecision(clerk: Clerk, approvalId: string, job: Job, answer: Answer) {
  const { decision, by: person } = answer;
  const attributes = {
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.approval.decision": decision,
    "x.approval.by": person,
  };
  await tracer(clerk.traceDir, job.run_id).span("x.approval", null, attributes, async () => {});
  if (decision === "decline") {
    clerk.store.decide(approvalId, "declined", person);
    const reason = `Declined by ${person}. Nothing was written.`;
    clerk.store.update(job.job_id, { status: "declined", column: "Refused", reason });
    return json({ approval_id: approvalId, status: "declined" });
  }
  clerk.store.decide(approvalId, "approved", person);
  const approvalStep = { by: person, at: new Date().toISOString() };
  clerk.store.update(job.job_id, {
    status: "working",
    column: null,
    steps: { ...job.steps, approval: approvalStep },
  });
  void runJob(clerk, job.job_id, true);
  return json({ approval_id: approvalId, status: "approved" });
}

async function answerContract(clerk: Clerk, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const [section, id] = url.pathname.split("/").filter(Boolean);
  if (route === "GET /health")
    return json({ contract: clerk.faults.contractVersion, employee: NAME, tenants: TENANTS });
  if (route === "POST /jobs") {
    const body = (await request.json().catch(() => null)) as NewJob | null;
    return createJob(clerk, body);
  }
  if (request.method === "GET" && section === "jobs" && id)
    return jobStatus(clerk, decodeURIComponent(id));
  if (route === "GET /approvals") {
    const status = url.searchParams.get("status") ?? undefined;
    return json(clerk.store.approvals(status).map(approvalForContract));
  }
  if (request.method === "POST" && section === "approvals" && id) {
    const answer = (await request.json().catch(() => ({}))) as ApprovalAnswer;
    return decide(clerk, decodeURIComponent(id), answer);
  }
  if (route === "GET /board") return json(board(clerk));
  return json({ error: "not found" }, 404);
}

// ---- Start ----

function hireClerk(faults: Faults): Clerk {
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const policyFile = process.env.POLICY_FILE ?? join(import.meta.dir, "..", "policy.yaml");
  return {
    faults,
    policy: Bun.YAML.parse(readFileSync(policyFile, "utf8")) as Policy,
    world: worldClient(),
    store: openStore(faults.persist ? stateDir : null),
    traceDir: process.env.TRACE_DIR ?? join(process.cwd(), "traces"),
    running: new Set<string>(),
  };
}

export function startEmployee(faultOverrides: Partial<Faults> = {}) {
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
  const clerk = hireClerk({ ...NO_FAULTS, ...faultOverrides });
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

  return {
    port: server.port,
    stop: () => {
      server.stop(true);
      boardServer?.stop(true);
    },
  };
}
