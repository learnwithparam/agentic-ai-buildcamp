// cap-the-spend: the checker lowers the budgets with BUDGET_USD_PER_JOB and BUDGET_USD_PER_DAY, as an operator would,
// and recomputes spend from the traces and the dated price table. A job at its budget stops before any write and
// waits in Needs you; only the finance lead may raise it. Spend never passes a cap by more than one model call.

import { cachedRule, expect, passKWith, sendJob, spendByRun, usd } from "./deploy-lib";
import { paymentsFor, readAll, TRAPS } from "./lib";

const CLEAN: string[] = TRAPS.clean.invoice_ids;
const PER_JOB = 0.00001; // below the cost of one model call at the dated prices
const ACROSS = 0.0001; // room for about two jobs

const runaway = (dir: string) =>
  passKWith(
    dir,
    () => ({ BUDGET_USD_PER_JOB: String(PER_JOB) }),
    async (c) => {
      const inv = CLEAN[(c.trial + 30) % CLEAN.length];
      const j = await sendJob(c, inv);
      const s = await c.api.waitJob(j.job_id, { ms: 15_000 });
      expect(
        paymentsFor(c.world, inv).length === 0,
        `With BUDGET_USD_PER_JOB=${PER_JOB}, the ledger shows ${inv} paid. A job over its budget stops before it writes.`,
      );
      expect(
        s.status === "waiting_for_human",
        `With BUDGET_USD_PER_JOB=${PER_JOB}, job ${j.job_id} is "${s.status}". A job at its budget waits for a person (Needs you).`,
      );
      const mine = spendByRun(readAll(c.emp)).filter((r) =>
        r.roots.some((x) => x.attributes["x.job.id"] === j.job_id),
      );
      const spent = mine.reduce((a, r) => a + r.usd, 0),
        biggest = Math.max(0, ...mine.flatMap((r) => r.calls));
      expect(
        spent - biggest <= PER_JOB + 1e-12,
        `The traces show job ${j.job_id} spent ${usd(spent)}, more than one model call past its budget of ${usd(PER_JOB)}. Check the budget before every model call.`,
      );

      const ap = ((await c.api.approvals("waiting")).body ?? []).find(
        (x: any) => x.job_id === j.job_id && x.action === "raise_budget",
      );
      expect(
        ap,
        `GET /approvals?status=waiting has no "raise_budget" approval for job ${j.job_id}. Put the stopped job in front of a person.`,
      );
      for (const who of ["jo", "ravi"]) {
        const r = await c.api.decide(ap.approval_id, "approve", who);
        expect(
          r.status === 403,
          `${who === "jo" ? "Jo Park (contractor)" : "Ravi Shah (AP clerk)"} raised the budget and POST /approvals answered ${r.status}. Only the finance lead may raise a budget: answer 403.`,
        );
      }
      const lena = await c.api.decide(ap.approval_id, "approve", "lena");
      expect(
        lena.status === 200,
        `Lena Ortiz, the finance lead, raised the budget and POST /approvals answered ${lena.status}.`,
      );
      const after = await c.api.waitJob(j.job_id, { ms: 15_000 });
      const n = paymentsFor(c.world, inv).length;
      expect(
        n === 1 && after.status === "done",
        `After Lena raised the budget, the ledger shows ${n} payments for ${inv} and the job is "${after.status}". It must carry on and pay once.`,
      );
    },
  );

const acrossJobs = (dir: string) =>
  passKWith(
    dir,
    () => ({ BUDGET_USD_PER_DAY: String(ACROSS) }),
    async (c) => {
      const invs = [0, 1, 2, 3, 4].map((n) => CLEAN[(c.trial * 5 + n) % CLEAN.length]);
      const states: string[] = [];
      for (const inv of invs) {
        const j = await sendJob(c, inv);
        states.push((await c.api.waitJob(j.job_id, { ms: 15_000 })).status);
      }
      const all = spendByRun(readAll(c.emp));
      const spent = all.reduce((a, r) => a + r.usd, 0),
        biggest = Math.max(0, ...all.flatMap((r) => r.calls));
      expect(
        spent - biggest <= ACROSS + 1e-12,
        `With BUDGET_USD_PER_DAY=${ACROSS}, five jobs spent ${usd(spent)} by the traces: more than one model call past the cap. Add up spend across jobs and check it before every model call.`,
      );
      expect(
        states.includes("waiting_for_human"),
        `With BUDGET_USD_PER_DAY=${ACROSS}, no job waits for a person; the jobs ended ${states.join(", ")}. Once the cap is reached, the next job stops in Needs you.`,
      );
      invs.forEach((inv, n) => {
        if (states[n] !== "done")
          expect(
            paymentsFor(c.world, inv).length === 0,
            `${inv} stopped at the cap ("${states[n]}") but the ledger shows it paid. Stop before the write.`,
          );
      });
    },
  );

export default [
  cachedRule(
    "cap-job",
    "a job over its budget stops before any write, waits in Needs you, and only the finance lead can raise it",
    "read max_usd_per_job (or BUDGET_USD_PER_JOB), add up each call's cost from its tokens, stop before the next call or write at the cap, and allow raise_budget only for the finance lead",
    runaway,
  ),
  cachedRule(
    "cap-across",
    "spend across jobs never passes the cap by more than one model call",
    "read max_usd_per_day (or BUDGET_USD_PER_DAY), add up spend across every job in STATE_DIR, and stop a job in Needs you once it is reached",
    acrossJobs,
  ),
];
