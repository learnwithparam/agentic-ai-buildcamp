// split-the-board-by-tenant: KaaS Freight and KaaS Dairy jobs run side by side. GET /board must show one row per
// tenant, and the checker recomputes each row from the traces (spend by the root span's x.tenant, at the dated
// prices) and the ledger (outcomes), within 2%.

import { cachedRule, expect, passKWith, sendJob, spendByRun, usd } from "./deploy-lib";
import { ledgerAgrees, priceTableAgeDays, priceTableTooOld, readAll, TRAPS } from "./lib";

const CLEAN: string[] = TRAPS.clean.invoice_ids;
const DAIRY: string[] = TRAPS.second_tenant.invoice_ids;
const near = (a: number, want: number) =>
  Math.abs(a - want) <= Math.max(0.02 * Math.abs(want), 1e-9);

const perTenant = (dir: string) =>
  passKWith(
    dir,
    () => ({}),
    async (c) => {
      expect(
        !priceTableTooOld(),
        `The price table in config/models.ts is ${priceTableAgeDays()} days old. Read today's prices and update it.`,
      );
      const work: Record<string, string[]> = {
        "kaas-freight": [
          CLEAN[(c.trial + 33) % CLEAN.length],
          CLEAN[(c.trial + 35) % CLEAN.length],
          TRAPS.duplicate.invoice_id,
        ],
        "kaas-dairy": [
          DAIRY[(c.trial * 2) % DAIRY.length],
          DAIRY[(c.trial * 2 + 1) % DAIRY.length],
        ],
      };
      const jobs = [];
      for (const [tenant, invs] of Object.entries(work))
        for (const inv of invs) jobs.push(await sendJob(c, inv, tenant));
      for (const j of jobs) await c.api.waitJob(j.job_id, { ms: 15_000 });

      const b = await c.api.board();
      expect(
        b.status === 200 && Array.isArray(b.body?.tenants),
        `GET /board answered ${b.status}. Answer {"tenants": [{"tenant", "outcomes", "spend_usd", "cost_per_outcome_usd"}]}.`,
      );
      const byRun = spendByRun(readAll(c.emp));
      for (const [tenant, invs] of Object.entries(work)) {
        const row = b.body.tenants.find((x: any) => x.tenant === tenant);
        expect(row, `GET /board has no row for ${tenant}. Group the board by each job's tenant.`);
        const spend = byRun
          .filter((r) => r.roots.some((s) => s.attributes["x.tenant"] === tenant))
          .reduce((a, r) => a + r.usd, 0);
        const outcomes = invs.filter((i) => ledgerAgrees(c.world, i)).length;
        expect(
          outcomes > 0,
          `None of ${tenant}'s invoices is settled in the ledger, so there is nothing to split. Pass isolate-the-second-tenant first.`,
        );
        expect(
          Number(row.outcomes) === outcomes,
          `The board says ${tenant} has ${row.outcomes} outcomes; the ledger shows ${outcomes} of its invoices settled.`,
        );
        expect(
          near(Number(row.spend_usd), spend),
          `The board says ${tenant} spent USD ${row.spend_usd}; the traces whose root says x.tenant = ${tenant} cost ${usd(spend)}. Add up spend per tenant.`,
        );
        expect(
          near(Number(row.cost_per_outcome_usd), spend / outcomes),
          `The board says ${tenant}'s cost per outcome is USD ${row.cost_per_outcome_usd}; the traces and the ledger give ${usd(spend / outcomes)}.`,
        );
      }
    },
  );

export default [
  cachedRule(
    "split-board",
    "GET /board shows each tenant's outcomes, spend and cost per outcome apart, matching the traces and the ledger within 2%",
    "put x.tenant on every root span, then group the board's outcomes and spend by the job's tenant, one row each",
    perTenant,
  ),
];
