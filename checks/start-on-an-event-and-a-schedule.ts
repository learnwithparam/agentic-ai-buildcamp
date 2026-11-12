// start-on-an-event-and-a-schedule: the world's webhook (sent twice, as webhooks are) and a timer that reads an inbox
// folder each start one job. The ledger shows each invoice paid once, the world's access log shows one job per
// invoice, and the root span of each run records the trigger kind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedRule,
  expect,
  fileRule,
  jobsThatTouched,
  passKWith,
  runs,
  tmp,
  waitFor,
  writeFile,
} from "./deploy-lib";
import { paymentsFor, readAll, TRAPS } from "./lib";

const CLEAN: string[] = TRAPS.clean.invoice_ids;
const TICK_MS = 300;

function rootKind(c: any, jobId: string): string | null {
  const root = runs(readAll(c.emp))
    .flatMap((r) => r.roots)
    .find((s) => s.attributes["x.job.id"] === jobId);
  return root ? String(root.attributes["x.trigger.kind"] ?? "(none)") : null;
}

const triggers = (dir: string) =>
  passKWith(
    dir,
    () => ({ INBOX_DIR: tmp("inbox"), SCHEDULE_EVERY_MS: String(TICK_MS) }),
    async (c) => {
      const byEvent = CLEAN[(c.trial + 20) % CLEAN.length],
        bySchedule = CLEAN[(c.trial + 24) % CLEAN.length];

      // The webhook: the world posts invoice.received, then posts the same event again.
      const event = {
        event_id: `evt-${c.jobId(byEvent)}`,
        type: "invoice.received",
        tenant: "kaas-freight",
        invoice_id: byEvent,
      };
      const post = () =>
        fetch(`${c.emp.base}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        })
          .then((r) => r.status)
          .catch(() => 0);
      const first = await post();
      expect(
        first >= 200 && first < 300,
        `POST /events answered ${first}. Answer 202 when the webhook starts a job, as POST /jobs does.`,
      );
      await Bun.sleep(150);
      const again = await post();
      expect(
        again >= 200 && again < 300,
        `The world sent the same event again and POST /events answered ${again}. A redelivered event answers 200 and starts nothing new.`,
      );
      expect(
        await waitFor(() => paymentsFor(c.world, byEvent).length > 0),
        `The webhook for ${byEvent} started no payment in 15 s. POST /events must start a job for the invoice it names.`,
      );

      // The timer: an invoice file lands in INBOX_DIR; the next tick starts a job, later ticks start nothing new.
      writeFile(
        c.env.INBOX_DIR,
        `${bySchedule}.json`,
        JSON.stringify({ tenant: "kaas-freight", invoice_id: bySchedule }),
      );
      expect(
        await waitFor(() => paymentsFor(c.world, bySchedule).length > 0),
        `${bySchedule} sat in INBOX_DIR and no tick paid it in 15 s. Every SCHEDULE_EVERY_MS, start a job for each invoice file there.`,
      );
      await Bun.sleep(TICK_MS * 5);

      for (const [inv, kind] of [
        [byEvent, "event"],
        [bySchedule, "schedule"],
      ] as const) {
        const n = paymentsFor(c.world, inv).length;
        expect(
          n === 1,
          `The ledger shows ${n} payments for ${inv}, started by ${kind === "event" ? "the webhook" : "the timer"}. It must show one.`,
        );
        const jobs = jobsThatTouched(c, inv);
        expect(
          jobs.length === 1,
          kind === "event"
            ? `The world's access log shows ${jobs.length} jobs on ${inv}: ${jobs.join(", ")}. The same event_id arrived twice; name the job after the event so a redelivery starts nothing new.`
            : `The world's access log shows ${jobs.length} jobs on ${inv}: ${jobs.join(", ")}. Each tick started it again; name the job after the invoice so the next tick finds it.`,
        );
        const k = rootKind(c, jobs[0]);
        expect(
          k !== null,
          `No trace has a root invoke_agent span with x.job.id = ${jobs[0]}. Send X-Job-Id with the same job id you trace.`,
        );
        expect(
          k === kind,
          `The root span of job ${jobs[0]} says x.trigger.kind = "${k}". ${kind === "event" ? "The webhook" : "The timer"} started it, so it must say "${kind}".`,
        );
      }
    },
  );

export default [
  fileRule(
    "employee.toml says the employee starts by a person, an event and a schedule",
    'add "event" and "schedule" to starts_by in the [hire] block of employee.toml',
    (empDir) => {
      const t: any = Bun.TOML.parse(readFileSync(join(empDir, "employee.toml"), "utf8"));
      const by: string[] = t.hire?.starts_by ?? [];
      const missing = ["person", "event", "schedule"].filter((k) => !by.includes(k));
      return missing.length
        ? `starts_by is ${JSON.stringify(by)}; it is missing ${missing.join(", ")}.`
        : null;
    },
  ),
  cachedRule(
    "triggers",
    "a webhook sent twice and an inbox file read by the timer each start one job, paid once, with the trigger kind on the root span",
    "add POST /events and a timer on SCHEDULE_EVERY_MS that reads INBOX_DIR, name each job after its event or invoice, and put the trigger kind on the root span",
    triggers,
  ),
];
