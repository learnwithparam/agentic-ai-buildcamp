import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { ReviewStore } from "../reviews";
import { escalateOverdue } from "./clock";

// The 24 hour clock against a real Postgres (the tests' own database; see sessions.test.ts).
// Items are planted with SQL under a unique thread and removed afterwards, so no other row is read as a result.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const tag = `clocktest-${randomUUID().slice(0, 8)}`;
const thread = `${tag}-thread`;
const id = (name: string) => `${tag}-${name}`;
const now = new Date("2026-11-26T12:00:00Z");
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);

async function plant(name: string, kind: string, status: string, dueInHours: number) {
  await pool.query("INSERT INTO review_items (id, kind, thread_id, tenant_id, question, body, due_at, status) VALUES ($1, $2, $3, 'pharma_a', 'q', 'b', $4, $5)", [id(name), kind, thread, hours(dueInHours), status]);
  if (kind === "adverse_event") await pool.query("INSERT INTO safety_notifications (item_id, kind, tenant_id) VALUES ($1, 'raised', 'pharma_a')", [id(name)]);
}
const row = async (name: string) =>
  (await pool.query("SELECT status, escalated_at, (SELECT count(*)::int FROM safety_notifications n WHERE n.item_id = r.id AND n.kind = 'escalated') AS escalations, (SELECT count(*)::int FROM safety_notifications n WHERE n.item_id = r.id) AS notices FROM review_items r WHERE id = $1", [id(name)])).rows[0];

before(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO threads (thread_id, owner_id, tenant_id) VALUES ($1, 'clock-test', 'pharma_a')", [thread]);
  await plant("overdue", "adverse_event", "waiting", -2);
  await plant("overdue-old", "adverse_event", "waiting", -400);
  await plant("not-due", "adverse_event", "waiting", 3);
  await plant("filed", "adverse_event", "filed", -50);
  await plant("draft", "draft", "waiting", -50);
});
after(async () => {
  await pool.query("DELETE FROM review_items WHERE thread_id = $1", [thread]);
  await pool.query("DELETE FROM threads WHERE thread_id = $1", [thread]);
  await pool.end();
});

test("an adverse event past its due time is escalated, with a second notification row", async () => {
  const done = await escalateOverdue(pool, now);
  const mine = done.filter((item) => item.id.startsWith(tag)).map((item) => item.id).sort();
  assert.deepEqual(mine, [id("overdue"), id("overdue-old")].sort());
  for (const name of ["overdue", "overdue-old"]) {
    const after = await row(name);
    assert.equal(after.status, "escalated");
    assert.equal(after.escalated_at.toISOString(), now.toISOString());
    assert.equal(after.notices, 2, "the raised row and the escalated row");
    assert.equal(after.escalations, 1);
  }
});

test("an item not yet due, an item already decided and another review kind are left alone", async () => {
  for (const [name, status] of [["not-due", "waiting"], ["filed", "filed"], ["draft", "waiting"]] as const) {
    const after = await row(name);
    assert.equal(after.status, status, name);
    assert.equal(after.escalated_at, null, name);
    assert.equal(after.escalations, 0, name);
  }
});

test("running the job again escalates nothing twice", async () => {
  const again = await escalateOverdue(pool, new Date(now.getTime() + 3_600_000));
  assert.deepEqual(again.filter((item) => item.id.startsWith(tag)), []);
  assert.equal((await row("overdue")).escalations, 1);
  assert.equal((await row("overdue")).escalated_at.toISOString(), now.toISOString());
});

test("an escalated item is still decided by a reviewer, once", async () => {
  const store = new ReviewStore(pool);
  const reviewer = { userId: "kc-safety", tenantId: "pharma_a", roles: ["safety_reviewer"] } as unknown as Parameters<ReviewStore["decide"]>[1];
  const decided = await store.decide(id("overdue"), reviewer, "filed", "filed in the safety database");
  assert.equal(decided?.status, "filed");
  assert.ok(decided?.escalatedAt, "the item keeps the time it was escalated");
  assert.equal(await store.decide(id("overdue"), reviewer, "dismissed", ""), null, "a second decision is refused");
});

test("a draft that waits is still decided as before (the other review kinds do not change)", async () => {
  const store = new ReviewStore(pool);
  const reviewer = { userId: "kc-med", tenantId: "pharma_a", roles: ["medical_reviewer"] } as unknown as Parameters<ReviewStore["decide"]>[1];
  assert.equal((await store.decide(id("draft"), reviewer, "approved", ""))?.status, "approved");
});
