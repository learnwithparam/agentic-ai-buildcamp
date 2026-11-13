// The Operate part's sample employee: the reference freight audit clerk with what running it in
// production asks for. It answers contract version 1 (reference/CONTRACT.md) and adds three things:
//   1. The model is a setting. MODEL_ROLE picks the role in config/models.ts (smart by default
//      here) and REPLAY_DIR picks the recorded replies that stand in for a model in replay mode.
//      The swap gate sets both.
//   2. GET /board counts every run's spend, failed and stopped runs too, and shows incidents.
//   3. When the ledger answers 503 it pauses every job, opens one incident card, probes the
//      ledger once a beat, and resumes the paused jobs when it answers again.
// Each solution/ and wrong/ folder in this part starts it with one Options object; a wrong/ folder
// plants one mistake a learner makes. Models are called only through reference/src/model.ts,
// which asks config/models.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, ROLES, type Role } from "../../config/models";
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
import type { Reply } from "../../reference/src/model";
import { type Approval, type Draft, type Job, openStore } from "../../reference/src/store";
import { tracer } from "../../reference/src/trace";
import { ToolFailed, worldClient } from "../../reference/src/world";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];
const PART = import.meta.dir;

export type Options = {
  countFailedRuns: boolean; // the board's spend counts every run, not only the ones that ended done
  pauseOnOutage: boolean; // a 503 from the ledger pauses the job until the ledger answers again
  oneIncidentCard: boolean; // one incident card for the outage, not one per paused job
};
export const READY: Options = { countFailedRuns: true, pauseOnOutage: true, oneIncidentCard: true };

// Words that make a line of a document an order to the employee, not a fact about the load.
const ORDERS =
  /\b(approved by|pay at once|pay immediately|no further checks|ignore (the|your|all) )/i;

type Policy = {
  limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number };
  approver_role: string;
};

type Incident = {
  incident_id: string;
  opened_at: string;
  closed_at: string | null;
  summary: string;
  jobs: string[];
};

type Chat = (label: string, system: string, user: string, role: Role) => Promise<Reply>;

// Everything the clerk works with, made once when it starts.
type Clerk = {
  options: Options;
  role: Role;
  chat: Chat;
  policy: Policy;
  world: ReturnType<typeof worldClient>;
  store: ReturnType<typeof openStore>;
  traceDir: string;
  running: Set<string>;
  incidents: Incident[];
  probeMs: number;
  maxPauseMs: number;
  // While the ledger is down: the probe loop that every paused job waits on.
  outage: Promise<void> | null;
};

// What one run of one job has at hand. Steps are the job's saved steps, changed in place.
type JobRun = {
  clerk: Clerk;
  job: Job;
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
const now = () => new Date().toISOString();

function requireJob(clerk: Clerk, jobId: string): Job {
  const job = clerk.store.get(jobId);
  if (!job) throw new Error(`there is no job ${jobId}`);
  return job;
}

// The role and the recordings that stand in for the model. The gate sets MODEL_ROLE and REPLAY_DIR.
export function modelSetting(env = process.env): { role: Role; replayDir: string } {
  const role = (env.MODEL_ROLE ?? "smart").trim() as Role;
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new Error(`MODEL_ROLE is "${role}". Set it to one of: ${ROLES.join(", ")}.`);
  }
  let defaultReplayDir = join(PART, "..", "..", "reference", "replay");
  if (role === "smart") {
    defaultReplayDir = join(PART, "06-run-the-swap-gate", "models", "smart", "replies");
  }
  return { role, replayDir: env.REPLAY_DIR ?? defaultReplayDir };
}

// ---- The outage: one incident, one probe loop, every paused job waits on the same promise ----

function newIncident(clerk: Clerk, jobId: string, summary: string): Incident {
  return {
    incident_id: `INC-${clerk.incidents.length + 1}`,
    opened_at: now(),
    closed_at: null,
    summary,
    jobs: [jobId],
  };
}

function recordIncident(clerk: Clerk, jobId: string, why: string) {
  if (!clerk.options.oneIncidentCard) {
    const summary = `Job ${jobId}: the ledger answers ${why}.`;
    clerk.incidents.push(newIncident(clerk, jobId, summary));
    return;
  }
  const openIncident = clerk.incidents.find((incident) => !incident.closed_at);
  if (!openIncident) {
    const summary =
      `The ledger answers ${why}. ` + "Jobs are paused, nothing is written until it answers again.";
    clerk.incidents.push(newIncident(clerk, jobId, summary));
    return;
  }
  if (!openIncident.jobs.includes(jobId)) openIncident.jobs.push(jobId);
}

// One cheap read. True when the ledger answers with anything but 503.
async function ledgerAnswers(clerk: Clerk): Promise<boolean> {
  try {
    const response = await fetch(`${clerk.world.base}/tools/read_invoice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant": "kaas-freight",
        "x-employee": NAME,
        "x-job-id": "probe",
      },
      body: JSON.stringify({ invoice_id: "INV-2001" }),
    });
    return response.status !== 503;
  } catch {
    return false;
  }
}

// Probes the ledger once a beat until it answers, then closes every open incident.
async function waitForLedger(clerk: Clerk) {
  const giveUpAt = Date.now() + clerk.maxPauseMs;
  while (Date.now() < giveUpAt) {
    await Bun.sleep(clerk.probeMs);
    if (await ledgerAnswers(clerk)) break;
  }
  for (const incident of clerk.incidents) {
    if (!incident.closed_at) incident.closed_at = now();
  }
  clerk.outage = null;
}

function ledgerDown(clerk: Clerk, jobId: string, why: string): Promise<void> {
  recordIncident(clerk, jobId, why);
  if (!clerk.outage) clerk.outage = waitForLedger(clerk);
  return clerk.outage;
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
    "x.model.role": clerk.role,
  };
  try {
    await trace.span("invoke_agent", null, attributes, async (root, addAttributes) => {
      const invoiceId = job.input.invoice_id;
      const run: JobRun = { clerk, job, invoiceId, trace, root };
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
  const { clerk, job, invoiceId } = run;
  // 1. Read the evidence. Saved, so a restart does not read it again.
  let evidence = job.steps.evidence;
  if (!evidence) {
    const invoice = await callTool<Invoice>(run, "read_invoice", { invoice_id: invoiceId });
    if (invoice.tenant !== job.tenant) return refuseOtherTenant(run, invoice);
    evidence = await readRestOfEvidence(run, invoice);
  }
  const summary = `${invoiceId}, ${evidence.load.carrier.name}, ${usd(evidence.invoice.total_usd)}`;
  clerk.store.update(job.job_id, { summary });

  // 2. The model drafts a decision. Saved too.
  const draft = job.steps.draft ?? (await draftDecision(run, evidence));

  // 3. The checker compares the draft with what the evidence allows.
  const rejection = await checkDraft(run, evidence, draft);
  if (rejection) return rejection;

  // 4. The policy gate, before any write. The model cannot see or change it.
  const key = `${job.tenant}:${invoiceId}:${draft.action}`;
  const verdict = await passPolicyGate(run, evidence, draft, key);
  if (verdict.refuse) {
    return {
      status: "stopped",
      column: "Refused",
      reason: `Refused by ${verdict.rule}: ${verdict.refuse}`,
    };
  }

  // 5. Over a limit, wait for a person.
  if (verdict.needsRole && !job.steps.approval) {
    return askForApproval(run, { decision: draft, summary, approverRole: verdict.needsRole });
  }

  // 6. Write with an idempotency key, then read the ledger to see it landed.
  return writeAndSettle(run, draft, key);
}

// Every tool call is a span. A call with an idempotency key is a write.
function callToolOnce<Reply>(
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
  const info = { tenant: job.tenant, job_id: job.job_id, employee: NAME, key };
  return run.trace.span("execute_tool", run.root, attributes, () =>
    clerk.world.call<Reply>(name, args, info),
  );
}

const isOutage = (error: unknown): error is ToolFailed =>
  error instanceof ToolFailed && error.status === 503;

// A 503 means the ledger is down, not that the job is wrong: pause, then try the same call again.
async function callTool<Reply>(
  run: JobRun,
  name: string,
  args: Record<string, unknown>,
  key?: string,
): Promise<Reply> {
  for (;;) {
    try {
      return await callToolOnce<Reply>(run, name, args, key);
    } catch (error) {
      if (!(run.clerk.options.pauseOnOutage && isOutage(error))) throw error;
      const pauseAttributes = { "x.pause.reason": error.message };
      await run.trace.span("x.pause", run.root, pauseAttributes, () =>
        ledgerDown(run.clerk, run.job.job_id, `503: ${error.message}`),
      );
    }
  }
}

function saveSteps(run: JobRun) {
  run.clerk.store.update(run.job.job_id, { steps: run.job.steps });
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
  run.job.steps.evidence = evidence;
  saveSteps(run);
  return evidence;
}

async function askTheModel(run: JobRun, evidence: Evidence): Promise<Reply> {
  const { clerk } = run;
  const attributes = {
    "gen_ai.request.model": "",
    "gen_ai.agent.name": NAME,
    "x.model.role": clerk.role,
  };
  return run.trace.span("chat", run.root, attributes, async (_id, addAttributes) => {
    const user = JSON.stringify(promptEvidence(evidence), null, 2);
    const reply = await clerk.chat(run.invoiceId, SYSTEM_PROMPT, user, clerk.role);
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
  if (spent === null) run.job.steps.cost_unknown = true;
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
  run.job.steps.draft = draft;
  saveSteps(run);
  return draft;
}

// A wrong draft stops the job, never the ledger.
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
  const reason =
    `The checker rejected the draft: it said ${draft.action} ${draft.reason_code ?? ""} ` +
    `USD ${draft.amount_usd}, the evidence says ${want.action} ${want.reason_code ?? ""} ` +
    `USD ${want.amount_usd}.`;
  // An empty reason code leaves two spaces; squeeze them into one.
  return { status: "stopped", column: "Refused", reason: reason.replace(/\s+/g, " ") };
}

// ---- The policy gate ----

const allow = (): Verdict => ({ rule: null, refuse: null, needsRole: null });
const refuse = (rule: string, why: string): Verdict => ({ rule, refuse: why, needsRole: null });
const askRole = (rule: string, role: string): Verdict => ({ rule, refuse: null, needsRole: role });

async function passPolicyGate(
  run: JobRun,
  evidence: Evidence,
  decision: Draft,
  ourKey: string,
): Promise<Verdict> {
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
  if (decision.approved_by && !run.job.steps.approval) {
    return refuse(
      "approvals-come-from-people",
      `the draft says ${decision.approved_by} approved this, but nobody approved it through ` +
        "the approval flow.",
    );
  }
  const { limits, approver_role: approverRole } = run.clerk.policy;
  if (decision.action === "pay") return paymentVerdict(run, evidence, decision, ourKey);
  if (decision.amount_usd > limits.dispute_usd_without_approval) {
    return askRole("limits.dispute_usd_without_approval", approverRole);
  }
  return allow();
}

function paymentVerdict(run: JobRun, evidence: Evidence, decision: Draft, ourKey: string): Verdict {
  const { invoice } = evidence;
  const { limits, approver_role: approverRole } = run.clerk.policy;
  const otherPayments = invoice.payments.filter((payment) => payment.idempotency_key !== ourKey);
  if (otherPayments.length > 0) {
    return refuse(
      "never-pay-twice",
      `${invoice.invoice_id} already has payment ${otherPayments[0].payment_id}.`,
    );
  }
  const allowed = allowedTotal(evidence).total;
  if (decision.amount_usd > allowed + 0.001) {
    return refuse(
      "never-pay-above-the-rate",
      `USD ${decision.amount_usd} is above the USD ${allowed} the rate and the proof of ` +
        "delivery allow.",
    );
  }
  if (decision.amount_usd > limits.pay_usd_without_approval) {
    return askRole("limits.pay_usd_without_approval", approverRole);
  }
  return allow();
}

// ---- Approval and the write ----

type ApprovalRequest = { decision: Draft; summary: string; approverRole: string };

function askForApproval(run: JobRun, request: ApprovalRequest): Outcome {
  const { decision, summary, approverRole } = request;
  const { store } = run.clerk;
  const approvalId = `APR-${run.job.job_id}`;
  const isPayment = decision.action === "pay";
  if (!store.approval(approvalId)) {
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
  }
  const doing = isPayment ? "paying" : "disputing";
  return {
    status: "waiting_for_human",
    column: "Needs you",
    reason:
      `${usd(decision.amount_usd)} is over the limit for ${doing} without approval. ` +
      `Waiting for the ${approverRole.replace("_", " ")}.`,
  };
}

function writeArguments(run: JobRun, decision: Draft): Record<string, unknown> {
  const { approval } = run.job.steps;
  const approvedBy = approval ? { approved_by: approval.by } : {};
  if (decision.action === "pay") {
    return { invoice_id: run.invoiceId, amount_usd: decision.amount_usd, ...approvedBy };
  }
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
async function ledgerShowsWrite(run: JobRun, decision: Draft, key: string) {
  const invoiceNow = await callTool<Invoice>(run, "read_invoice", { invoice_id: run.invoiceId });
  const rows = decision.action === "pay" ? invoiceNow.payments : invoiceNow.disputes;
  return rows.some((row) => row.idempotency_key === key);
}

// Up to three tries with the same key, so the world writes once however often we ask.
async function writeAndSettle(run: JobRun, decision: Draft, key: string): Promise<Outcome> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failure = await tryWrite(run, decision, key);
    lastError = failure?.message ?? "";
    // The world said the request itself is wrong, so the same request will not work either.
    if (failure && failure.status >= 400 && failure.status < 500) break;
    if (await ledgerShowsWrite(run, decision, key)) return done(decision, run.invoiceId);
    if (!lastError) lastError = "the write answered, but the ledger shows nothing";
  }
  const written = decision.action === "pay" ? "payment" : "dispute";
  return {
    status: "failed",
    column: "Needs you",
    reason: `The ledger shows no ${written} for ${run.invoiceId}. Last error: ${lastError}.`,
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
  const outcomes = doneJobs.length;
  // The planted forgets-failed-runs mistake counts only the runs that ended done.
  let countedJobs = doneJobs;
  if (clerk.options.countFailedRuns) countedJobs = jobs;
  const spend = countedJobs.reduce((total, job) => total + (job.spend_usd ?? 0), 0);
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
    incidents: clerk.incidents.map((incident) => ({
      ...incident,
      status: incident.closed_at ? "closed" : "open",
    })),
  };
}

function startBoard(clerk: Clerk, boardPort: number) {
  return Bun.serve({
    port: boardPort,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/board/data") {
        return json({
          board: board(clerk),
          jobs: clerk.store.all().map(({ steps: _steps, ...job }) => job),
          approvals: clerk.store.approvals("waiting"),
        });
      }
      if (url.pathname === "/" || url.pathname === "/board") {
        return new Response(boardPage(NAME), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return json({ error: "not found" }, 404);
    },
  });
}

// ---- The contract over HTTP ----

type NewJob = { job_id?: string; tenant?: string; trigger?: Job["trigger"]; input?: Job["input"] };
type ApprovalAnswer = { decision?: string; by?: string } | null;
type Answer = { decision: string; by: string };

function createJob(clerk: Clerk, body: NewJob | null): Response {
  if (!body?.job_id || !body?.tenant || !body?.input?.invoice_id) {
    return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
  }
  if (!TENANTS.includes(body.tenant)) {
    return json({ error: `this employee does not work for ${body.tenant}` }, 400);
  }
  const seen = clerk.store.get(body.job_id);
  if (seen) return json({ job_id: seen.job_id, run_id: seen.run_id }, 200);
  const createdAt = now();
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
    created_at: createdAt,
    updated_at: createdAt,
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
  const { decided_by: _decidedBy, ...details } = approval;
  return details;
}

// Why this person may not decide this approval, or null when they may.
async function approverProblem(clerk: Clerk, approval: Approval, job: Job, answer: Answer) {
  const { decision, by } = answer;
  const people = await clerk.world.people();
  const person = people.find((someone) => someone.person_id === by);
  if (!person) return `nobody called ${by} works here`;
  if (person.tenant !== job.tenant) {
    return `${person.name} works for ${person.tenant}, not ${job.tenant}`;
  }
  if (!person.may_approve) {
    return `${person.name} is a ${person.role.replace("_", " ")} and may not approve or decline`;
  }
  const isPayment = approval.action === "pay_invoice";
  const limit = isPayment ? person.pay_limit_usd : person.dispute_limit_usd;
  // Only an approval can go over a limit; anyone who may approve may also decline.
  if (decision === "approve" && limit !== null && approval.amount > limit) {
    return `${usd(approval.amount)} is over ${person.name}'s limit of ${usd(limit)}`;
  }
  return null;
}

async function decide(clerk: Clerk, approvalId: string, answer: ApprovalAnswer) {
  const approval = clerk.store.approval(approvalId);
  if (!approval) return json({ error: "no such approval" }, 404);
  if (approval.status !== "waiting") return json({ error: `already ${approval.status}` }, 409);
  const decision = answer?.decision ?? "";
  if (!["approve", "decline"].includes(decision) || !answer?.by) {
    return json({ error: 'send {"decision": "approve" or "decline", "by": person id}' }, 400);
  }
  const checked: Answer = { decision, by: answer.by };
  const job = requireJob(clerk, approval.job_id);
  const problem = await approverProblem(clerk, approval, job, checked);
  if (problem) return json({ reason: problem }, 403);
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
  const approvalStep = { by: person, at: now() };
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
  if (route === "GET /health") return json({ contract: "1", employee: NAME, tenants: TENANTS });
  if (route === "POST /jobs") {
    const body = (await request.json().catch(() => null)) as NewJob | null;
    return createJob(clerk, body);
  }
  if (request.method === "GET" && section === "jobs" && id) {
    return jobStatus(clerk, decodeURIComponent(id));
  }
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

async function hireClerk(options: Options): Promise<Clerk> {
  const setting = modelSetting();
  // reference/src/model.ts reads REPLAY_DIR when it loads, so set it before the import.
  process.env.REPLAY_DIR = setting.replayDir;
  const { chat } = await import("../../reference/src/model");
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const defaultPolicy = join(PART, "..", "..", "reference", "policy.yaml");
  const policyFile = process.env.POLICY_FILE ?? defaultPolicy;
  return {
    options,
    role: setting.role,
    chat,
    policy: Bun.YAML.parse(readFileSync(policyFile, "utf8")) as Policy,
    world: worldClient(),
    store: openStore(stateDir),
    traceDir: process.env.TRACE_DIR ?? join(process.cwd(), "traces"),
    running: new Set<string>(),
    incidents: [],
    probeMs: Number(process.env.PROBE_MS ?? 200),
    maxPauseMs: Number(process.env.MAX_PAUSE_MS ?? 600_000),
    outage: null,
  };
}

export async function operateEmployee(overrides: Partial<Options> = {}) {
  const clerk = await hireClerk({ ...READY, ...overrides });
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
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
    role: clerk.role,
    stop: () => {
      server.stop(true);
      boardServer?.stop(true);
    },
  };
}
