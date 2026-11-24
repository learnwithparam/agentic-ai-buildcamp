import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createTestStore } from "../../scripts/fga-model";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { createPool, migrate } from "./db";
import { env } from "./env";
import type { Turn } from "./graph";
import type { MedinfoAgent } from "./medinfo-agent";
import { ReviewStore, type ReviewItem } from "./reviews";
import type { SessionStore } from "./sessions";

// Lesson 13. The inbox routes against a real Postgres and a real OpenFGA store made for the test.
// The tokens are signed by a key the test made, so every reviewer here is a token, not a body field.
// The agent is a stand-in that records what the decision route asks it to resume: no model calls.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

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

const person = (sub: string, tenant: string, roles: string[] = []): JWTPayload => ({
  sub,
  name: sub,
  email: `${sub}@example.com`,
  organization: [tenant],
  country: "US",
  realm_access: { roles: ["default-roles-medinfo", ...roles] }
});
const rivera = person("kc-rivera", "pharma_a");
const chen = person("kc-chen", "pharma_a", ["medical-reviewer"]);
const haddad = person("kc-haddad", "pharma_a", ["safety-reviewer"]);
const rossi = person("kc-rossi", "pharma_b", ["medical-reviewer"]);

const token = (claims: JWTPayload) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "kc-1" }).setIssuer(ISSUER).setAudience("medinfo-api").setIssuedAt().setExpirationTime("5m").sign(privateKey);

const pool = createPool(env.testDatabaseUrl);
const resumed: Turn[] = [];
const scored: ReviewItem[] = [];
const agent = { runTurn: async (turn: Turn) => (resumed.push(turn), { messages: [], waitingForApproval: false }), readThread: async () => ({ messages: [], interrupts: [] }) };
let reviews: ReviewStore;
let base = "";
let close = () => {};
let dropStore = async () => {};
const run = crypto.randomUUID().slice(0, 8);
const ids = { draftA: `draft-${run}-a`, draftA2: `draft-${run}-a2`, eventA: `ae-${run}-a`, draftB: `draft-${run}-b` };
const threads = { a: `thread-${run}-a`, b: `thread-${run}-b` };

before(async () => {
  await migrate(pool);
  const store = await createTestStore(env.fgaApiUrl, env.fgaApiToken);
  dropStore = async () => void (await store.client.deleteStore());
  reviews = new ReviewStore(pool, () => store.client);
  const desk = { agent: agent as unknown as MedinfoAgent, reviews, recordDecision: async (item: ReviewItem) => void scored.push(item) };
  const server = createApp(auth, desk).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();

  const doctor = { userId: "kc-rivera", name: "", email: "", tenantId: "pharma_a", country: "US", roles: [] };
  await reviews.createThread(threads.a, doctor);
  await reviews.createThread(threads.b, { ...doctor, userId: "kc-okafor", tenantId: "pharma_b" });
  const item = { question: "Draft a reply", body: "REVIEW_REQUIRED\n\nDraft", traceId: "trace-1" };
  await reviews.submit({ ...item, id: ids.draftA, kind: "draft", threadId: threads.a, tenantId: "pharma_a" });
  await reviews.submit({ ...item, id: ids.draftA2, kind: "draft", threadId: threads.a, tenantId: "pharma_a" });
  await reviews.submit({ ...item, id: ids.eventA, kind: "adverse_event", threadId: threads.a, tenantId: "pharma_a" });
  await reviews.submit({ ...item, id: ids.draftB, kind: "draft", threadId: threads.b, tenantId: "pharma_b" });
});
after(async () => {
  close();
  await pool.query("DELETE FROM review_items WHERE thread_id = ANY($1)", [Object.values(threads)]);
  await pool.query("DELETE FROM threads WHERE thread_id = ANY($1)", [Object.values(threads)]);
  await pool.end();
  await dropStore();
});

async function call(claims: JWTPayload, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await token(claims)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
const inboxIds = async (claims: JWTPayload) =>
  ((await call(claims, "/api/inbox")).json.items as ReviewItem[]).map((item) => item.id).filter((id) => id.includes(run)).sort();

test("a medical reviewer's inbox holds their company's drafts, not safety reports or another company's", async () => {
  assert.deepEqual(await inboxIds(chen), [ids.draftA, ids.draftA2].sort());
  assert.deepEqual(await inboxIds(haddad), [ids.eventA]);
  assert.deepEqual(await inboxIds(rossi), [ids.draftB]);
});

test("a doctor sees what their own questions raised, and may decide none of it", async () => {
  const mine = await call(rivera, "/api/inbox");
  assert.equal(mine.json.reviewer, false);
  assert.deepEqual(await inboxIds(rivera), [ids.draftA, ids.draftA2, ids.eventA].sort());
  assert.equal((await call(rivera, `/api/inbox/${ids.draftA}/decision`, { decision: "approved" })).status, 403);
});

test("a reviewer from another company, or of the other kind, is refused", async () => {
  assert.equal((await call(rossi, `/api/inbox/${ids.draftA}/decision`, { decision: "approved" })).status, 403);
  assert.equal((await call(haddad, `/api/inbox/${ids.draftA}/decision`, { decision: "approved" })).status, 403);
  assert.equal((await call(chen, `/api/inbox/${ids.draftA}/decision`, { decision: "filed" })).status, 400);
});

test("the approver is the signed-in reviewer, whatever the body says, and the thread resumes", async () => {
  const response = await call(chen, `/api/inbox/${ids.draftA}/decision`, { decision: "approved", decidedBy: "kc-someone-else", reviewer: "kc-rossi" });
  assert.equal(response.status, 200);
  assert.equal(response.json.decidedBy, "kc-chen");
  assert.deepEqual(
    resumed.map((turn) => [turn.threadId, turn.resume, turn.user.userId]),
    [[threads.a, "approve", "kc-chen"]]
  );
  assert.deepEqual(scored.map((item) => [item.id, item.status, item.decidedBy, item.traceId]), [[ids.draftA, "approved", "kc-chen", "trace-1"]]);
  assert.equal((await call(chen, `/api/inbox/${ids.draftA}/decision`, { decision: "rejected" })).status, 409);
  assert.deepEqual(await inboxIds(chen), [ids.draftA2]);
});

test("a safety reviewer files a report without resuming any thread", async () => {
  const before = resumed.length;
  const response = await call(haddad, `/api/inbox/${ids.eventA}/decision`, { decision: "filed", note: "Sent to the safety database." });
  assert.equal(response.status, 200);
  assert.equal(response.json.status, "filed");
  assert.equal(resumed.length, before);
});

test("an item submitted twice is one row with one deadline", async () => {
  const again = await reviews.submit({ id: ids.draftA2, kind: "draft", threadId: threads.a, tenantId: "pharma_a", question: "x", body: "x" });
  const { rows } = await pool.query("SELECT count(*)::int AS n, min(due_at) AS due FROM review_items WHERE id = $1", [ids.draftA2]);
  assert.equal(rows[0].n, 1);
  assert.equal(again.dueAt.getTime(), new Date(rows[0].due).getTime());
  const hours = (again.dueAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 47 && hours <= 48, `a draft is due in 48 hours, got ${hours.toFixed(1)}`);
});
