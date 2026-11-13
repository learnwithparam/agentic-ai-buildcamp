// split-the-board-by-tenant: KaaS Freight and KaaS Dairy jobs run side by side. GET /board must
// show one row per tenant, and the checker recomputes each row from the traces (spend by the root
// span's x.tenant, at the dated prices) and the ledger (outcomes), within 2%.

import {
  cachedRule,
  type DeployContext,
  expect,
  passTrialsWith,
  sendJob,
  spendByRun,
  usd,
} from "./deploy-lib";
import { ledgerAgrees, priceTableAgeDays, priceTableTooOld, readAll, TRAPS } from "./lib";

const CLEAN_INVOICES: string[] = TRAPS.clean.invoice_ids;
const DAIRY_INVOICES: string[] = TRAPS.second_tenant.invoice_ids;

type BoardRow = {
  tenant: string;
  outcomes: number | string;
  spend_usd: number | string;
  cost_per_outcome_usd: number | string;
};
type RunSpend = ReturnType<typeof spendByRun>[number];

// Within 2% of the wanted figure, with a tiny floor so a wanted zero still matches zero.
function isNear(actual: number, wanted: number): boolean {
  const allowed = Math.max(0.02 * Math.abs(wanted), 1e-9);
  return Math.abs(actual - wanted) <= allowed;
}

// Each trial picks different invoices for each tenant, so a board learned once cannot pass.
function invoicesByTenant(trial: number): Record<string, string[]> {
  return {
    "kaas-freight": [
      CLEAN_INVOICES[(trial + 33) % CLEAN_INVOICES.length],
      CLEAN_INVOICES[(trial + 35) % CLEAN_INVOICES.length],
      TRAPS.duplicate.invoice_id,
    ],
    "kaas-dairy": [
      DAIRY_INVOICES[(trial * 2) % DAIRY_INVOICES.length],
      DAIRY_INVOICES[(trial * 2 + 1) % DAIRY_INVOICES.length],
    ],
  };
}

async function runEveryJob(context: DeployContext, work: Record<string, string[]>) {
  const jobs = [];
  for (const [tenant, invoices] of Object.entries(work)) {
    for (const invoice of invoices) jobs.push(await sendJob(context, invoice, tenant));
  }
  for (const job of jobs) await context.api.waitJob(job.job_id, { ms: 15_000 });
}

async function readBoard(context: DeployContext): Promise<BoardRow[]> {
  const board = await context.api.board();
  expect(
    board.status === 200 && Array.isArray(board.body?.tenants),
    `GET /board answered ${board.status}. ` +
      'Answer {"tenants": [{"tenant", "outcomes", "spend_usd", "cost_per_outcome_usd"}]}.',
  );
  return board.body.tenants as BoardRow[];
}

// What the traces say this tenant spent: every run whose root span carries its x.tenant.
function tenantSpend(spendingRuns: RunSpend[], tenant: string): number {
  const tenantRuns = spendingRuns.filter((run) =>
    run.roots.some((root) => root.attributes["x.tenant"] === tenant),
  );
  return tenantRuns.reduce((total, run) => total + run.usd, 0);
}

type TenantFigures = { tenant: string; row: BoardRow; spend: number; outcomes: number };

// The board's row must match the ledger's outcomes and the traces' spend for this tenant.
function rowMatches({ tenant, row, spend, outcomes }: TenantFigures) {
  expect(
    Number(row.outcomes) === outcomes,
    `The board says ${tenant} has ${row.outcomes} outcomes; ` +
      `the ledger shows ${outcomes} of its invoices settled.`,
  );
  expect(
    isNear(Number(row.spend_usd), spend),
    `The board says ${tenant} spent USD ${row.spend_usd}; ` +
      `the traces whose root says x.tenant = ${tenant} cost ${usd(spend)}. ` +
      "Add up spend per tenant.",
  );
  expect(
    isNear(Number(row.cost_per_outcome_usd), spend / outcomes),
    `The board says ${tenant}'s cost per outcome is USD ${row.cost_per_outcome_usd}; ` +
      `the traces and the ledger give ${usd(spend / outcomes)}.`,
  );
}

function perTenant(dir: string) {
  return passTrialsWith(
    dir,
    () => ({}),
    async (context) => {
      expect(
        !priceTableTooOld(),
        `The price table in config/models.ts is ${priceTableAgeDays()} days old. ` +
          "Read today's prices and update it.",
      );
      const work = invoicesByTenant(context.trial);
      await runEveryJob(context, work);
      const rows = await readBoard(context);
      const spendingRuns = spendByRun(readAll(context.emp));
      for (const [tenant, invoices] of Object.entries(work)) {
        const row = rows.find((boardRow) => boardRow.tenant === tenant);
        expect(row, `GET /board has no row for ${tenant}. Group the board by each job's tenant.`);
        const spend = tenantSpend(spendingRuns, tenant);
        const settled = invoices.filter((invoice) => ledgerAgrees(context.world, invoice));
        expect(
          settled.length > 0,
          `None of ${tenant}'s invoices is settled in the ledger, so there is nothing to split. ` +
            "Pass isolate-the-second-tenant first.",
        );
        rowMatches({ tenant, row, spend, outcomes: settled.length });
      }
    },
  );
}

export default [
  cachedRule(
    "split-board",
    "GET /board shows each tenant's outcomes, spend and cost per outcome apart, " +
      "matching the traces and the ledger within 2%",
    "put x.tenant on every root span, " +
      "then group the board's outcomes and spend by the job's tenant, one row each",
    perTenant,
  ),
];
