import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../app";
import { createAuth } from "../auth";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { ReviewStore } from "../reviews";
import type { SessionStore } from "../sessions";
import { escalateOverdue } from "../safety/clock";
import { testDesk } from "../test-desk";
import type { Identity } from "../users";
import { ChatLimiter, LIMIT_MESSAGE } from "./limits";

// Lesson 23. The audit trail and the per-user limits, against a real Postgres. No model call and
// no OpenFGA: a decision here is the store's SQL, and the limited requests stop at "no such thread".

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
before(() => migrate(pool));
after(() => pool.end());

const reviewer = (userId: string): Identity => ({ userId, name: "Reviewer", email: "r@example.com", tenantId: "pharma_a", country: "US", roles: ["medical-reviewer"] });

async function waitingItem() {
  const id = `ops-${randomUUID()}`;
  const thread = `ops-thread-${randomUUID()}`;
  await pool.query("INSERT INTO threads (thread_id, owner_id, tenant_id) VALUES ($1, 'asker', 'pharma_a')", [thread]);
  await pool.query(
    "INSERT INTO review_items (id, kind, thread_id, tenant_id, question, body, due_at) VALUES ($1, 'draft', $2, 'pharma_a', 'q', 'b', now() + interval '1 day')",
    [id, thread]
  );
  return id;
}

const events = async (id: string) =>
  (await pool.query<{ actor: string; action: string; before: Record<string, unknown>; after: Record<string, unknown>; at: Date }>(
    "SELECT actor, action, before, after, at FROM review_events WHERE item_id = $1 ORDER BY id",
    [id]
  )).rows;

// The store's decision SQL does not ask OpenFGA, so the test hands it no client.
const store = new ReviewStore(pool, () => {
  throw new Error("OpenFGA was not expected here.");
});

test("a decision writes one event with the state before and after, who decided and when", async () => {
  const id = await waitingItem();
  const decided = await store.decide(id, reviewer("kc-chen"), "approved", "matches section 2.2");
  assert.equal(decided?.status, "approved");
  const [event, ...rest] = await events(id);
  assert.equal(rest.length, 0);
  assert.equal(event!.actor, "kc-chen");
  assert.equal(event!.action, "approved");
  assert.deepEqual(event!.before, { status: "waiting", decided_by: null, decided_at: null, note: null, escalated_at: null });
  assert.equal(event!.after.status, "approved");
  assert.equal(event!.after.decided_by, "kc-chen");
  assert.equal(event!.after.note, "matches section 2.2");
  assert.ok(Math.abs(event!.at.getTime() - Date.now()) < 60_000);
});

test("a second decision on the same item changes nothing and writes no event", async () => {
  const id = await waitingItem();
  await store.decide(id, reviewer("kc-chen"), "approved", "");
  assert.equal(await store.decide(id, reviewer("kc-rossi"), "rejected", "too late"), null);
  assert.equal((await events(id)).length, 1);
  assert.equal((await store.get(id))?.status, "approved");
});

test("reopening keeps the decision in the trail and adds a row by the system", async () => {
  const id = await waitingItem();
  await store.decide(id, reviewer("kc-chen"), "rejected", "no");
  await store.reopen(id);
  assert.equal((await store.get(id))?.status, "waiting");
  const trail = await events(id);
  assert.deepEqual(trail.map((e) => [e.actor, e.action]), [["kc-chen", "rejected"], ["system", "reopened"]]);
  assert.equal(trail[1]!.before.status, "rejected");
  assert.equal(trail[1]!.after.status, "waiting");
  // The item can be decided again, and that is a third row, not a rewrite of the first.
  await store.decide(id, reviewer("kc-chen"), "approved", "");
  assert.deepEqual((await events(id)).map((e) => e.action), ["rejected", "reopened", "approved"]);
});

test("the safety clock's escalation is in the trail, by the system, and a reviewer still decides the item", async () => {
  const id = await waitingItem();
  await pool.query("UPDATE review_items SET kind = 'adverse_event', due_at = now() - interval '1 hour' WHERE id = $1", [id]);
  const now = new Date();
  assert.ok((await escalateOverdue(pool, now)).some((item) => item.id === id));
  const [escalation] = await events(id);
  assert.deepEqual([escalation!.actor, escalation!.action, escalation!.before.status, escalation!.after.status], ["system", "escalated", "waiting", "escalated"]);
  assert.equal(escalation!.before.escalated_at, null);
  assert.equal(new Date(String(escalation!.after.escalated_at)).getTime(), now.getTime());
  await store.decide(id, reviewer("kc-chen"), "approved", "reported");
  assert.deepEqual((await events(id)).map((e) => [e.action, e.before.status]), [["escalated", "waiting"], ["approved", "escalated"]]);
});

test("Postgres refuses to change, remove or empty the trail", async () => {
  const id = await waitingItem();
  await store.decide(id, reviewer("kc-chen"), "approved", "");
  await assert.rejects(pool.query("UPDATE review_events SET actor = 'someone else' WHERE item_id = $1", [id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM review_events WHERE item_id = $1", [id]), /append-only/);
  await assert.rejects(pool.query("TRUNCATE review_events"), /append-only/);
  const [event] = await events(id);
  assert.equal(event!.actor, "kc-chen");
});

test("the limiter allows the cap, refuses the next turn, and counts per user", async () => {
  const limiter = new ChatLimiter(pool, { perMinute: 3, perDay: 5 });
  const user = `limit-${randomUUID()}`;
  const start = new Date("2026-11-23T10:00:00Z");
  for (let i = 0; i < 3; i++) assert.deepEqual(await limiter.take(user, new Date(start.getTime() + i * 1000)), { allowed: true });
  const refused = await limiter.take(user, new Date(start.getTime() + 3000));
  assert.deepEqual(refused, { allowed: false, retryAfterSeconds: 57 });
  // Another person is not slowed down by it.
  assert.deepEqual(await limiter.take(`limit-${randomUUID()}`, start), { allowed: true });
  // A minute after the first turn, one place is free again. A refused turn was not counted.
  assert.deepEqual(await limiter.take(user, new Date(start.getTime() + 61_000)), { allowed: true });
});

test("the daily cap holds after the minute limit has cleared, and lifts a day after the first turn", async () => {
  const limiter = new ChatLimiter(pool, { perMinute: 3, perDay: 5 });
  const user = `limit-${randomUUID()}`;
  const start = new Date("2026-11-23T10:00:00Z");
  for (let i = 0; i < 5; i++) assert.equal((await limiter.take(user, new Date(start.getTime() + i * 120_000))).allowed, true);
  const later = new Date(start.getTime() + 3_600_000);
  const refused = await limiter.take(user, later);
  assert.equal(refused.allowed, false);
  assert.ok(!refused.allowed && refused.retryAfterSeconds > 3600 * 20);
  assert.equal((await limiter.take(user, new Date(start.getTime() + 86_400_000 + 1000))).allowed, true);
});

test("one user's simultaneous requests cannot slip past the cap", async () => {
  const limiter = new ChatLimiter(pool, { perMinute: 4, perDay: 100 });
  const user = `limit-${randomUUID()}`;
  const now = new Date("2026-11-23T10:00:00Z");
  const results = await Promise.all(Array.from({ length: 10 }, () => limiter.take(user, now)));
  assert.equal(results.filter((r) => r.allowed).length, 4);
});

// The same limiter on the real app: signed-in requests to a chat stream, 429 once the cap is spent.
const ISSUER = "https://keycloak.test/realms/medinfo";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "kc-1", alg: "RS256", use: "sig" };
const auth = createAuth({
  issuer: ISSUER,
  audience: "medinfo-api",
  clientId: "medinfo-chat",
  clientSecret: "test-client-secret",
  appUrl: "http://127.0.0.1:3333",
  sessions: {} as SessionStore,
  keys: createLocalJWKSet({ keys: [jwk] }),
  client: async () => {
    throw new Error("not used");
  }
});
const bearer = (sub: string) =>
  new SignJWT({ sub, name: sub, email: `${sub}@example.com`, organization: ["pharma_a"], country: "US" })
    .setProtectedHeader({ alg: "RS256", kid: "kc-1" })
    .setIssuer(ISSUER)
    .setAudience("medinfo-api")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

test("the chat API answers 429 after the cap, in plain words, and only for the chat streams", async () => {
  const server = createApp(auth, testDesk(pool), new ChatLimiter(pool, { perMinute: 2, perDay: 100 })).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { Authorization: `Bearer ${await bearer(`kc-ops-${randomUUID()}`)}`, "Content-Type": "application/json" };
    const ask = (path = "/api/threads/not-mine/runs/stream") =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify({ messages: [{ id: "1", type: "human", content: "hi" }] }) });
    // Under the cap the request reaches the route, which stops at "no such thread" before any model.
    assert.equal((await ask()).status, 404);
    assert.equal((await ask()).status, 404);
    const refused = await ask();
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: LIMIT_MESSAGE });
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    // The insights stream shares the user's count.
    assert.equal((await ask("/api/insights/threads/not-mine/runs/stream")).status, 429);
    // Other routes are not turns.
    assert.equal((await fetch(`${base}/api/me`, { headers })).status, 200);
    // Nobody signed in: sign-in is asked for first, and nothing is counted for no one.
    assert.equal((await fetch(`${base}/api/threads/x/runs/stream`, { method: "POST", headers: { Origin: "http://127.0.0.1:3333" } })).status, 401);
  } finally {
    server.close();
  }
});
