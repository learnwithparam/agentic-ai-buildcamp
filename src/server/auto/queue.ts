import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { TODAY } from "../tools";
import type { Sweep, SweepResult } from "./sweep";

// Lesson 17. When the sweep runs, and the log of every run.
//   - a pg-boss schedule per company starts it every night at 02:00 UTC, with nobody there;
//   - a person can start it now from the sweep page, with one instruction added;
//   - the queue holds at most one running and one waiting sweep per company (the "stately" policy),
//     so a second click or a late night run never starts a sweep beside the one already working;
//   - a sweep is never retried by the queue: a failed run is logged, and the next night runs again.

export const SWEEP_QUEUE = "hcp-sweep";
export const SWEEP_CRON = "0 2 * * *";

export type SweepJob = { tenantId: string; trigger: "schedule" | "person"; requestedBy?: string; instruction?: string; today?: string };

export type SweepRun = {
  runId: string;
  tenantId: string;
  trigger: SweepJob["trigger"];
  requestedBy: string | null;
  instruction: string | null;
  status: "running" | "done" | "budget_stop" | "paused" | "failed";
  steps: number;
  spentUsd: number | null;
  report: string | null;
  itemIds: string[];
  traceId: string | null;
  failed: boolean;
  startedAt: string;
  finishedAt: string | null;
};

export interface SweepRuns {
  start(runId: string, job: SweepJob): Promise<void>;
  finish(runId: string, result: SweepResult): Promise<void>;
  fail(runId: string, error: string): Promise<void>;
  list(tenantId: string, limit?: number): Promise<SweepRun[]>;
}

const STATUS = { DONE: "done", BUDGET_STOP: "budget_stop", AGENT_PAUSED: "paused" } as const;

type Row = {
  run_id: string;
  tenant_id: string;
  trigger: SweepJob["trigger"];
  requested_by: string | null;
  instruction: string | null;
  status: SweepRun["status"];
  steps: number;
  spent_usd: string | null;
  report: string | null;
  item_ids: string[];
  trace_id: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
};

export class PostgresSweepRuns implements SweepRuns {
  constructor(private pool: pg.Pool) {}

  async start(runId: string, job: SweepJob) {
    await this.pool.query(
      `INSERT INTO sweep_runs (run_id, tenant_id, trigger, requested_by, instruction) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (run_id) DO NOTHING`,
      [runId, job.tenantId, job.trigger, job.requestedBy ?? null, job.instruction ?? null]
    );
  }

  async finish(runId: string, result: SweepResult) {
    await this.pool.query(
      `UPDATE sweep_runs SET status = $2, steps = $3, spent_usd = $4, report = $5, item_ids = $6, trace_id = $7, finished_at = now() WHERE run_id = $1`,
      [runId, STATUS[result.outcome], result.steps, result.spentUsd, result.report, result.itemIds, result.traceId ?? null]
    );
  }

  async fail(runId: string, error: string) {
    await this.pool.query(`UPDATE sweep_runs SET status = 'failed', error = $2, finished_at = now() WHERE run_id = $1`, [runId, error]);
  }

  async list(tenantId: string, limit = 20) {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM sweep_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`, [tenantId, limit]);
    return rows.map((row) => ({
      runId: row.run_id,
      tenantId: row.tenant_id,
      trigger: row.trigger,
      requestedBy: row.requested_by,
      instruction: row.instruction,
      status: row.status,
      steps: row.steps,
      spentUsd: row.spent_usd === null ? null : Number(row.spent_usd),
      report: row.report,
      itemIds: row.item_ids,
      traceId: row.trace_id,
      // The error itself stays in the table and the server log; the page only says the run failed.
      failed: row.status === "failed",
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null
    }));
  }
}

// The run log in memory, for scripts (the dataset run) and tests.
export class MemorySweepRuns implements SweepRuns {
  private runs = new Map<string, SweepRun>();

  async start(runId: string, job: SweepJob) {
    if (this.runs.has(runId)) return;
    this.runs.set(runId, {
      runId,
      tenantId: job.tenantId,
      trigger: job.trigger,
      requestedBy: job.requestedBy ?? null,
      instruction: job.instruction ?? null,
      status: "running",
      steps: 0,
      spentUsd: null,
      report: null,
      itemIds: [],
      traceId: null,
      failed: false,
      startedAt: new Date().toISOString(),
      finishedAt: null
    });
  }

  async finish(runId: string, result: SweepResult) {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, { status: STATUS[result.outcome], steps: result.steps, spentUsd: result.spentUsd, report: result.report, itemIds: result.itemIds, traceId: result.traceId ?? null, finishedAt: new Date().toISOString() });
  }

  async fail(runId: string, _error: string) {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, { status: "failed", failed: true, finishedAt: new Date().toISOString() });
  }

  async list(tenantId: string, limit = 20) {
    return [...this.runs.values()].filter((run) => run.tenantId === tenantId).reverse().slice(0, limit);
  }
}

// One run, from the queue or a script: logged before it starts, closed when it ends.
export async function runSweep(sweep: Sweep, runs: SweepRuns, runId: string, job: SweepJob) {
  await runs.start(runId, job);
  try {
    const result = await sweep({ tenantId: job.tenantId, today: job.today ?? TODAY, runId, instruction: job.instruction });
    await runs.finish(runId, result);
    return result;
  } catch (error) {
    console.error(`The sweep ${runId} failed:`, error);
    await runs.fail(runId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export type SweepQueue = { runNow(job: SweepJob): Promise<string | null> };

export async function startSweepQueue(boss: PgBoss, sweep: Sweep, runs: SweepRuns, tenantIds: string[]): Promise<SweepQueue> {
  await boss.createQueue(SWEEP_QUEUE, { policy: "stately", retryLimit: 0 });
  // One schedule per company, keyed by the company, so the night runs are separate jobs.
  for (const tenantId of tenantIds) {
    await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, { tenantId, trigger: "schedule" } satisfies SweepJob, { tz: "UTC", key: tenantId, singletonKey: tenantId });
  }
  await boss.work<SweepJob>(SWEEP_QUEUE, { pollingIntervalSeconds: 2 }, async ([job]) => {
    await runSweep(sweep, runs, job.id, job.data);
  });
  return {
    // null: a sweep for this company is already waiting, so this one was not added.
    runNow: (job) => boss.send(SWEEP_QUEUE, job, { singletonKey: job.tenantId })
  };
}
