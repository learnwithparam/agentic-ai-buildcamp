// start-on-an-event-and-a-schedule: the world's webhook (sent twice, as webhooks are) and a timer
// that reads an inbox folder each start one job. The ledger shows each invoice paid once, the
// world's access log shows one job per invoice, and the root span of each run records the trigger
// kind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedRule,
  type DeployContext,
  expect,
  fileRule,
  jobsThatTouched,
  passTrialsWith,
  runs,
  temporaryFolder,
  waitFor,
  writeFile,
} from "./deploy-lib";
import { paymentsFor, readAll, TRAPS } from "./lib";

const CLEAN_INVOICES: string[] = TRAPS.clean.invoice_ids;
const TICK_MS = 300;

type TriggerKind = "event" | "schedule";
// Who starts each kind of job, as the failure messages name it.
const STARTER: Record<TriggerKind, string> = { event: "the webhook", schedule: "the timer" };
const STARTER_AT_SENTENCE_START: Record<TriggerKind, string> = {
  event: "The webhook",
  schedule: "The timer",
};
type EmployeeToml = { hire?: { starts_by?: string[] } };

// The x.trigger.kind on the root span of a job's run, or null when no run has that job.
function rootKind(context: DeployContext, jobId: string): string | null {
  const allRoots = runs(readAll(context.emp)).flatMap((run) => run.roots);
  const root = allRoots.find((span) => span.attributes["x.job.id"] === jobId);
  if (!root) return null;
  return String(root.attributes["x.trigger.kind"] ?? "(none)");
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

// The world posts invoice.received, then posts the same event again, as real webhooks do.
async function webhookSentTwice(context: DeployContext, invoice: string) {
  const event = {
    event_id: `evt-${context.jobId(invoice)}`,
    type: "invoice.received",
    tenant: "kaas-freight",
    invoice_id: invoice,
  };
  const postEvent = () =>
    fetch(`${context.emp.base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    })
      .then((response) => response.status)
      .catch(() => 0);
  const first = await postEvent();
  expect(
    isSuccess(first),
    `POST /events answered ${first}. Answer 202 when the webhook starts a job, as POST /jobs does.`,
  );
  await Bun.sleep(150);
  const again = await postEvent();
  expect(
    isSuccess(again),
    `The world sent the same event again and POST /events answered ${again}. ` +
      "A redelivered event answers 200 and starts nothing new.",
  );
  expect(
    await waitFor(() => paymentsFor(context.world, invoice).length > 0),
    `The webhook for ${invoice} started no payment in 15 s. ` +
      "POST /events must start a job for the invoice it names.",
  );
}

// An invoice file lands in INBOX_DIR; the next tick starts a job, later ticks start nothing new.
async function inboxFileReadByTheTimer(context: DeployContext, invoice: string) {
  const file = JSON.stringify({ tenant: "kaas-freight", invoice_id: invoice });
  writeFile(context.env.INBOX_DIR, `${invoice}.json`, file);
  expect(
    await waitFor(() => paymentsFor(context.world, invoice).length > 0),
    `${invoice} sat in INBOX_DIR and no tick paid it in 15 s. ` +
      "Every SCHEDULE_EVERY_MS, start a job for each invoice file there.",
  );
  await Bun.sleep(TICK_MS * 5);
}

// The fix to suggest when one start turned into several jobs.
function oneJobAdvice(kind: TriggerKind): string {
  if (kind === "event") {
    return (
      "The same event_id arrived twice; " +
      "name the job after the event so a redelivery starts nothing new."
    );
  }
  return "Each tick started it again; name the job after the invoice so the next tick finds it.";
}

// One payment, one job and the right trigger kind on the root span.
function startedOnce(context: DeployContext, invoice: string, kind: TriggerKind) {
  const paymentCount = paymentsFor(context.world, invoice).length;
  expect(
    paymentCount === 1,
    `The ledger shows ${paymentCount} payments for ${invoice}, started by ${STARTER[kind]}. ` +
      "It must show one.",
  );
  const jobs = jobsThatTouched(context, invoice);
  expect(
    jobs.length === 1,
    `The world's access log shows ${jobs.length} jobs on ${invoice}: ${jobs.join(", ")}. ` +
      oneJobAdvice(kind),
  );
  const recordedKind = rootKind(context, jobs[0]);
  expect(
    recordedKind !== null,
    `No trace has a root invoke_agent span with x.job.id = ${jobs[0]}. ` +
      "Send X-Job-Id with the same job id you trace.",
  );
  expect(
    recordedKind === kind,
    `The root span of job ${jobs[0]} says x.trigger.kind = "${recordedKind}". ` +
      `${STARTER_AT_SENTENCE_START[kind]} started it, so it must say "${kind}".`,
  );
}

function triggerEnvironment(): Record<string, string> {
  return Object.fromEntries([
    ["INBOX_DIR", temporaryFolder("inbox")],
    ["SCHEDULE_EVERY_MS", String(TICK_MS)],
  ]);
}

function triggers(dir: string) {
  return passTrialsWith(dir, triggerEnvironment, async (context) => {
    const startedByEvent = CLEAN_INVOICES[(context.trial + 20) % CLEAN_INVOICES.length];
    const startedBySchedule = CLEAN_INVOICES[(context.trial + 24) % CLEAN_INVOICES.length];
    await webhookSentTwice(context, startedByEvent);
    await inboxFileReadByTheTimer(context, startedBySchedule);
    startedOnce(context, startedByEvent, "event");
    startedOnce(context, startedBySchedule, "schedule");
  });
}

function missingStarters(employeeDir: string): string | null {
  const text = readFileSync(join(employeeDir, "employee.toml"), "utf8");
  const employee = Bun.TOML.parse(text) as EmployeeToml;
  const startsBy: string[] = employee.hire?.starts_by ?? [];
  const missing = ["person", "event", "schedule"].filter((kind) => !startsBy.includes(kind));
  if (missing.length === 0) return null;
  return `starts_by is ${JSON.stringify(startsBy)}; it is missing ${missing.join(", ")}.`;
}

export default [
  fileRule(
    "employee.toml says the employee starts by a person, an event and a schedule",
    'add "event" and "schedule" to starts_by in the [hire] block of employee.toml',
    missingStarters,
  ),
  cachedRule(
    "triggers",
    "a webhook sent twice and an inbox file read by the timer each start one job, " +
      "paid once, with the trigger kind on the root span",
    "add POST /events and a timer on SCHEDULE_EVERY_MS that reads INBOX_DIR, " +
      "name each job after its event or invoice, and put the trigger kind on the root span",
    triggers,
  ),
];
