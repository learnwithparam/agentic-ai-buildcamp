import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate } from "./db";
import { env } from "./env";
import { hashId, PostgresSessionStore } from "./sessions";

// Lesson 11. The real session store against a real Postgres: the tests' own database from
// infra/docker-compose.yml (npm run identity:setup writes TEST_DATABASE_URL; CI starts the same).

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const store = new PostgresSessionStore(pool);
const made: string[] = [];

before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.query("DELETE FROM sessions WHERE id_hash = ANY($1)", [made.map(hashId)]);
  await pool.end();
});

const hour = (hours: number) => new Date(Date.now() + hours * 3_600_000);

test("migrations run once, however often the server starts", async () => {
  assert.deepEqual(await migrate(pool), []);
  const { rows } = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
  assert.ok(rows.some((row) => row.name === "001_sessions.sql"));
});

test("a session is found by its cookie id, and the table never holds that id", async () => {
  const id = await store.create({
    userId: "kc-rivera",
    accessToken: "access",
    refreshToken: "refresh",
    idToken: "id",
    accessExpiresAt: hour(0.1),
    expiresAt: hour(8)
  });
  made.push(id);
  assert.equal((await store.get(id))?.userId, "kc-rivera");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE id_hash = $1", [id]);
  assert.equal(rows[0].n, 0, "the raw cookie id is stored");

  await store.updateTokens(id, { accessToken: "access-2", refreshToken: "refresh-2", idToken: null, accessExpiresAt: hour(0.2) });
  const updated = await store.get(id);
  assert.equal(updated?.accessToken, "access-2");
  assert.equal(updated?.idToken, "id", "a refresh without an id token dropped the one sign-out needs");

  await store.delete(id);
  assert.equal(await store.get(id), null);
});

test("an expired session is not found", async () => {
  const id = await store.create({
    userId: "kc-rivera",
    accessToken: "a",
    refreshToken: null,
    idToken: null,
    accessExpiresAt: hour(-1),
    expiresAt: hour(-0.5)
  });
  made.push(id);
  assert.equal(await store.get(id), null);
});

test("a sign-in attempt can be used once, and not after it expires", async () => {
  const login = { codeVerifier: "v", state: "s", nonce: "n", returnTo: "/", expiresAt: hour(0.1) };
  const id = await store.createPending(login);
  assert.equal((await store.takePending(id))?.state, "s");
  assert.equal(await store.takePending(id), null);
  const old = await store.createPending({ ...login, expiresAt: hour(-0.1) });
  assert.equal(await store.takePending(old), null);
});
