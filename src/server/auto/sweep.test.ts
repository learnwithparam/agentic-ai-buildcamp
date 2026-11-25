import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { PgBoss } from "pg-boss";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { staleAnswers, type EventDesk } from "../events/handlers";
import { AGENT_ROLES, REVIEWER_ROLES, sweepWorker } from "../users";
import { FixedControls, langfuseSpend, PostgresAgentControls, spendQuery, startOfDay, type AgentControls } from "./limits";
import { MemorySweepRuns, runSweep, startSweepQueue, SWEEP_CRON, SWEEP_QUEUE } from "./queue";
import { countingDesk, fgaOfPharmaA } from "./counting-desk";
import { createSweep, doctorLine, type Sweep } from "./sweep";
import { noModelCall } from "../../../scripts/no-model-call";

// Lesson 17. What the nightly sweep promises, without a model call (the picker on the real model
// is sweep.live.ts):
//   - a paused sweep does nothing, and a pause while it works stops it before the next step;
//   - a spent budget stops it before the first step;
//   - it finds the open answers a new label made stale, on the day that label is in force;
//   - it decides nothing;
//   - its spend is read from Langfuse with its own user id;
//   - the schedule is one pg-boss job per company, and at most one sweep waits per company.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
before(() => migrate(pool));
after(() => pool.end());

const LIMITS = { paused: false, budgetUsd: 0.5, changedBy: null, changedAt: null };

const sweepWith = (desk: EventDesk, controls: AgentControls, spend: (tenantId: string, since: Date) => Promise<number>) =>
  createSweep({ desk, controls, spend, model: noModelCall, client: fgaOfPharmaA });

const run = (sweep: Sweep, today = "2027-03-02", instruction?: string) => sweep({ tenantId: "pharma_a", today, runId: "test", instruction });

describe("the limits", () => {
  test("a paused sweep stops before its first step and calls no agent", async () => {
    const { desk, asked, planned } = countingDesk();
    const result = await run(sweepWith(desk, new FixedControls({ ...LIMITS, paused: true, changedBy: "Omar Haddad" }), async () => 0), "2027-03-02", "Clear the pending sample requests.");
    assert.equal(result.outcome, "AGENT_PAUSED");
    assert.match(result.report, /^AGENT_PAUSED: the sweep cannot go on: Omar Haddad paused it, so it stopped before step 1/);
    assert.deepEqual([asked.length, planned.length, result.steps], [0, 0, 0]);
  });

  test("a pause while the sweep works stops it before the next step", async () => {
    const controls = new FixedControls(LIMITS);
    // Someone pulls the switch while the first draft is being written.
    const { desk, asked, planned } = countingDesk(async () => void (await controls.setPaused("pharma_a", true, "Omar Haddad")));
    const result = await run(sweepWith(desk, controls, async () => 0), "2027-03-02", "Clear the pending sample requests.");
    assert.equal(result.outcome, "AGENT_PAUSED");
    assert.match(result.report, /stopped before step 2/);
    assert.deepEqual([asked.length, planned.length, result.steps], [1, 0, 1]);
  });

  test("a spent budget stops the sweep before its first step, even with no work to do", async () => {
    const { desk, asked } = countingDesk();
    const result = await run(sweepWith(desk, new FixedControls({ ...LIMITS, budgetUsd: 0.01 }), async () => 0.012), "2026-11-23");
    assert.equal(result.outcome, "BUDGET_STOP");
    assert.match(result.report, /^BUDGET_STOP: the sweep cannot go on today: it has spent 0\.012 USD of its 0\.01 USD budget, so it stopped before step 1/);
    assert.equal(asked.length, 0);
  });

  test("the sweep reads the switch and the budget it is given, never one of its own", async () => {
    const reads: string[] = [];
    const controls: AgentControls = { get: async (tenantId) => (reads.push(tenantId), LIMITS), setPaused: async () => LIMITS };
    const { desk } = countingDesk();
    const since: Date[] = [];
    const now = new Date("2027-03-02T02:00:05Z");
    await createSweep({ desk, controls, spend: async (_tenant, from) => (since.push(from), 0), model: noModelCall, client: fgaOfPharmaA, now: () => now })({ tenantId: "pharma_a", today: "2027-03-02", runId: "t" });
    assert.deepEqual(reads, ["pharma_a"]);
    assert.deepEqual(since.map((date) => date.toISOString()), ["2027-03-02T00:00:00.000Z"]);
  });
});

describe("the work", () => {
  test("the open answers a new label made stale, on the day it is in force and not before", () => {
    assert.deepEqual(
      staleAnswers("pharma_a", "2027-03-02").map(({ answer, inForce }) => `${answer.answerId} ${answer.docId} -> ${inForce}`),
      ["A-01 cardionex-uspi-v2 -> cardionex-uspi-v3"]
    );
    assert.deepEqual(staleAnswers("pharma_a", "2026-11-23"), []);
    assert.deepEqual(staleAnswers("pharma_b", "2027-03-02"), []);
  });

  test("a redraft runs as the sweep, on the thread the label event uses", async () => {
    const { desk, asked } = countingDesk();
    const result = await run(sweepWith(desk, new FixedControls(LIMITS), async () => 0));
    assert.equal(result.outcome, "DONE");
    assert.deepEqual(asked, ["sweep-pharma_a-us 2027-03-02 redraft-pharma_a-A-01-cardionex-uspi-v3"]);
    assert.match(result.report, /^SWEEP_DONE: 1 step for Pharma A on 2027-03-02\. 1 open answer cites a label no longer in force/);
    assert.match(result.report, /\[answers, A-01\]/);
  });

  test("the picker reads facts from the CRM files for each doctor", () => {
    const line = doctorLine({ hcpId: "HCP-1001", tenantId: "pharma_a", country: "US", specialty: "cardiology", emailConsent: true, preferredChannel: "email" });
    assert.match(line, /^HCP-1001: cardiology, US, email consent yes; sample requests: R-01 pending; campaigns sent: heart-failure-update-nov$/);
  });

  test("the sweep decides nothing: its one role is no reviewer role, and its code has no decision", () => {
    const identity = sweepWorker("pharma_a", "US");
    assert.deepEqual(identity.roles, ["sweep-agent"]);
    assert.ok(AGENT_ROLES.every((role) => !(REVIEWER_ROLES as readonly string[]).includes(role)));
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      assert.doesNotMatch(readFileSync(path.join(dir, file), "utf8"), /\b(decide|canDecide|recordDecision)\(/, `${file} decides an item`);
    }
  });
});

describe("the spend meter", () => {
  test("asks Langfuse for today's cost of this company's sweep only, after sending its own spans", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      calls.push(`fetch ${url.pathname}`);
      const query = JSON.parse(url.searchParams.get("query")!);
      assert.deepEqual(query.filters, [{ column: "userId", operator: "starts with", value: "sweep-pharma_a-", type: "string" }]);
      assert.equal(query.fromTimestamp, "2027-03-02T00:00:00.000Z");
      return new Response(JSON.stringify({ data: [{ sum_totalCost: 0.0042 }] }));
    }) as typeof fetch;
    const spend = langfuseSpend({ flush: async () => void calls.push("flush"), fetchImpl });
    assert.equal(await spend("pharma_a", startOfDay(new Date("2027-03-02T13:00:00Z"))), 0.0042);
    assert.deepEqual(calls, ["flush", "fetch /api/public/v2/metrics"]);
  });

  test("a spend Langfuse cannot answer stops the sweep instead of letting it run blind", async () => {
    const spend = langfuseSpend({ fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch });
    await assert.rejects(spend("pharma_a", new Date()), /Langfuse answered 503/);
    const { desk, asked } = countingDesk();
    const runs = new MemorySweepRuns();
    await assert.rejects(runSweep(sweepWith(desk, new FixedControls(LIMITS), spend), runs, "blind", { tenantId: "pharma_a", trigger: "schedule", today: "2027-03-02" }));
    assert.equal(asked.length, 0);
    assert.equal((await runs.list("pharma_a"))[0].status, "failed");
  });

  test("no day is counted twice: the query starts at midnight UTC", () => {
    const query = spendQuery("pharma_b", startOfDay(new Date("2027-03-02T23:59:00Z")), new Date("2027-03-02T23:59:00Z"));
    assert.equal(query.fromTimestamp, "2027-03-02T00:00:00.000Z");
    assert.deepEqual(query.metrics, [{ measure: "totalCost", aggregation: "sum" }]);
  });
});

describe("in Postgres", () => {
  test("the kill switch is one row per company and says who changed it", async () => {
    const controls = new PostgresAgentControls(pool);
    const tenant = `test-${Date.now()}`;
    try {
      assert.deepEqual(await controls.get(tenant), { paused: false, budgetUsd: 0.5, changedBy: null, changedAt: null });
      const paused = await controls.setPaused(tenant, true, "Omar Haddad");
      assert.equal(paused.paused, true);
      assert.equal(paused.changedBy, "Omar Haddad");
      assert.ok(paused.changedAt);
      assert.equal((await controls.get(tenant)).paused, true);
    } finally {
      await pool.query("DELETE FROM agent_controls WHERE tenant_id = $1", [tenant]);
    }
  });

  test("the schedule is one nightly job per company, and at most one sweep waits per company", async () => {
    const boss = new PgBoss({ connectionString: env.testDatabaseUrl!, schema: "pgboss" });
    boss.on("error", () => {});
    await boss.start();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    // A stand-in sweep that holds until the test lets it go, so one stays running.
    const sweep = (async () => {
      started++;
      await gate;
      return { outcome: "DONE", report: "SWEEP_DONE", steps: 0, spentUsd: 0, itemIds: [] };
    }) as unknown as Sweep;
    const tenants = [`test-a-${Date.now()}`, `test-b-${Date.now()}`];
    try {
      await boss.deleteQueue(SWEEP_QUEUE).catch(() => {});
      const queue = await startSweepQueue(boss, sweep, new MemorySweepRuns(), tenants);
      const schedules = (await boss.getSchedules()).filter((schedule) => schedule.name === SWEEP_QUEUE);
      assert.deepEqual(schedules.map((schedule) => [schedule.key, schedule.cron, schedule.timezone]).sort(), tenants.map((tenant) => [tenant, SWEEP_CRON, "UTC"]).sort());

      const job = { tenantId: tenants[0], trigger: "person" as const };
      assert.ok(await queue.runNow(job));
      for (let wait = 0; wait < 50 && started === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(started, 1, "the first sweep started");
      assert.ok(await queue.runNow(job), "a second waits behind the running one");
      assert.equal(await queue.runNow(job), null, "a third is refused while one waits");
      assert.ok(await queue.runNow({ ...job, tenantId: tenants[1] }), "another company's sweep is its own");
    } finally {
      release();
      for (const tenant of tenants) await boss.unschedule(SWEEP_QUEUE, tenant);
      await boss.stop({ graceful: false });
      await boss.deleteQueue(SWEEP_QUEUE).catch(() => {});
    }
  });
});
