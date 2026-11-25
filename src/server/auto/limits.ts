import type pg from "pg";
import { env } from "../env";
import { SWEEP_USER_PREFIX } from "../users";

// Lesson 17. The two limits the nightly sweep works within, read before every step it takes:
//   - the kill switch: one row per company (migration 007). A person pauses the sweep, and the
//     next step it reaches stops it, with nothing more done.
//   - the daily budget: what the sweep spent today, read from Langfuse, the same place every
//     cost in this app is read. Nothing here estimates a cost of its own.

export type Controls = { paused: boolean; budgetUsd: number; changedBy: string | null; changedAt: string | null };

export interface AgentControls {
  get(tenantId: string): Promise<Controls>;
  setPaused(tenantId: string, paused: boolean, by: string): Promise<Controls>;
}

type Row = { paused: boolean; daily_budget_usd: string; changed_by: string | null; changed_at: Date | null };
const toControls = (row: Row): Controls => ({
  paused: row.paused,
  budgetUsd: Number(row.daily_budget_usd),
  changedBy: row.changed_by,
  changedAt: row.changed_at?.toISOString() ?? null
});

export class PostgresAgentControls implements AgentControls {
  constructor(private pool: pg.Pool) {}

  async get(tenantId: string) {
    // The first read makes the row with the defaults, so every company has limits from day one.
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO agent_controls (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING *`,
      [tenantId]
    );
    return toControls(rows[0]);
  }

  async setPaused(tenantId: string, paused: boolean, by: string) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO agent_controls (tenant_id, paused, changed_by, changed_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET paused = $2, changed_by = $3, changed_at = now() RETURNING *`,
      [tenantId, paused, by]
    );
    return toControls(rows[0]);
  }
}

// Fixed limits for scripts (the dataset run): each case names whether the sweep is paused.
export class FixedControls implements AgentControls {
  constructor(private controls: Controls) {}
  async get() {
    return this.controls;
  }
  async setPaused(_tenantId: string, paused: boolean, by: string) {
    this.controls = { ...this.controls, paused, changedBy: by, changedAt: new Date().toISOString() };
    return this.controls;
  }
}

// What the sweep of one company has spent since a moment, in USD.
export type SpendReader = (tenantId: string, since: Date) => Promise<number>;

// The start of the day the budget counts, in UTC: the schedule runs in UTC too.
export const startOfDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// The Langfuse metrics query for one company's sweep: the cost of every model call whose trace
// carries a sweep user id of that company (users.ts sweepWorker). Exported for its test.
export function spendQuery(tenantId: string, since: Date, until: Date) {
  return {
    view: "observations",
    metrics: [{ measure: "totalCost", aggregation: "sum" }],
    dimensions: [],
    filters: [{ column: "userId", operator: "starts with", value: `${SWEEP_USER_PREFIX}-${tenantId}-`, type: "string" }],
    fromTimestamp: since.toISOString(),
    toTimestamp: until.toISOString()
  };
}

// Langfuse's metrics API (v2, the one a v4 deployment serves). `flush` sends the spans still
// waiting in this process first, so the last step's cost is on its way before the read. Langfuse
// still takes a few seconds to count it, so the check can lag one step behind: the gateway key's
// own daily budget (lesson 10) is the hard ceiling under this one.
export function langfuseSpend({ flush, fetchImpl = fetch }: { flush?: () => Promise<void>; fetchImpl?: typeof fetch } = {}): SpendReader {
  return async (tenantId, since) => {
    await flush?.();
    const url = new URL("/api/public/v2/metrics", env.langfuseBaseUrl);
    url.searchParams.set("query", JSON.stringify(spendQuery(tenantId, since, new Date())));
    const auth = Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64");
    const response = await fetchImpl(url, { headers: { authorization: `Basic ${auth}` } });
    // A spend the sweep cannot read is treated as spent: it never works without a known budget.
    if (!response.ok) throw new Error(`Langfuse answered ${response.status} to the spend query.`);
    const body = (await response.json()) as { data: Array<{ sum_totalCost?: number | null }> };
    return Number(body.data[0]?.sum_totalCost ?? 0);
  };
}
