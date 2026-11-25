import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { TENANTS } from "../users";
import { COLUMNS } from "./agent";
import { loadSales, salesRows, SMALL_GROUP } from "./load";
import { biPool, closeBiPools, refusal, runQuery } from "./query";

// Lesson 22. The promise here is in Postgres and the parser, not in the model, so these run attacks
// straight at them with no model call. Each one is SQL a model could write, or be talked into writing.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const owner = createPool(env.testDatabaseUrl);
const url = env.testDatabaseUrl;

before(async () => {
  await migrate(owner);
  await loadSales(owner);
});
after(async () => {
  await closeBiPools();
  await owner.end();
});

// The login's own connection, with no parser in front: what Postgres alone allows.
async function asLogin(tenantId: string, sql: string) {
  const client = await biPool(tenantId, url).connect();
  try {
    return await client.query(sql);
  } finally {
    client.release();
  }
}

test("each company has its own login, and it cannot write, switch role or skip the row rule", async () => {
  const { rows } = await owner.query(
    "SELECT rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolconnlimit FROM pg_roles WHERE rolname LIKE 'bi\\_%' ORDER BY rolname"
  );
  assert.deepEqual(
    rows.map((row) => row.rolname),
    Object.keys(TENANTS).map((tenant) => `bi_${tenant}`).sort()
  );
  for (const row of rows) assert.deepEqual([row.rolcanlogin, row.rolinherit, row.rolbypassrls, row.rolsuper, row.rolconnlimit], [true, false, false, false, 5]);
});

test("a login sees only its own company's rows, whatever the SQL asks for", async () => {
  for (const tenant of Object.keys(TENANTS)) {
    const result = await runQuery("SELECT DISTINCT tenant_id FROM bi.territory_rx", tenant, url);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.rows, [{ tenant_id: tenant }]);
  }
  const asked = await runQuery("SELECT sum(trx) AS trx FROM bi.territory_rx WHERE tenant_id = 'pharma_b'", "pharma_a", url);
  assert.ok(asked.ok);
  assert.equal(asked.rows[0].trx, null, "Pharma A's login summed Pharma B's rows");
});

test("the app's own role reads none of the published rows: the wrong pool fails closed", async () => {
  const { rows } = await owner.query("SELECT count(*)::int AS n FROM bi.territory_rx");
  assert.equal(rows[0].n, 0);
});

test("the raw rows, with each prescriber, cannot be read by a login even with no parser in front", async () => {
  await assert.rejects(asLogin("pharma_a", "SELECT * FROM sales.prescriptions"), /permission denied/);
});

test("a setting changed inside a SELECT does not move the row rule", async () => {
  // Postgres alone: the login may change a setting of its own, and current_user stays the same.
  const forged = await asLogin("pharma_a", "SELECT set_config('app.tenant', 'pharma_b', false), count(*) FILTER (WHERE tenant_id = 'pharma_b')::int AS b FROM bi.territory_rx");
  assert.equal(forged.rows[0].b, 0);
  // Switching to the other company's login needs membership, which no login has.
  await assert.rejects(asLogin("pharma_a", "SELECT set_config('role', 'bi_pharma_b', false)"), /permission denied/);
  // And the parser refuses both before they reach Postgres.
  assert.match((await refusal("SELECT set_config('role', 'bi_pharma_b', false)"))!, /set_config is not on the allowed list/);
});

test("a login cannot write, even through a function or a second statement", async () => {
  await assert.rejects(asLogin("pharma_a", "DELETE FROM bi.territory_rx"), /read-only transaction|permission denied/);
  const attacks: Array<[string, RegExp]> = [
    ["DELETE FROM sales.prescriptions", /Only a SELECT may run, not DELETE/],
    ["SELECT 1; DELETE FROM sales.prescriptions", /Send one statement, not 2/],
    ["SELECT * INTO bi.copy FROM bi.territory_rx", /SELECT INTO makes a table/],
    ["SELECT * FROM bi.territory_rx FOR UPDATE", /lock rows/],
    ["SELECT pg_sleep(10)", /pg_sleep is not on the allowed list/],
    ["SELECT pg_read_file('/etc/passwd')", /pg_read_file is not on the allowed list/],
    ["SELECT * FROM sales.prescriptions", /not sales.prescriptions/],
    ["SELECT * FROM pg_roles", /not pg_roles/],
    ["WITH x AS (SELECT * FROM pg_catalog.pg_authid) SELECT * FROM x", /not pg_catalog.pg_authid/],
    ["SELECT (SELECT max(prescriber) FROM sales.prescriptions) FROM bi.territory_rx", /not sales.prescriptions/]
  ];
  for (const [sql, reason] of attacks) assert.match((await refusal(sql)) ?? "allowed", reason, sql);
});

test("a slow query stops at 3 seconds on the login itself", async () => {
  // pg_sleep is refused by the parser; this proves the login's own limit holds without it.
  await assert.rejects(asLogin("pharma_a", "SELECT pg_sleep(10)"), /statement timeout/);
});

test("a group of fewer than 11 prescribers is left out, and the totals match the vendor rows", async () => {
  const groups = new Map<string, { trx: number; prescribers: Set<string> }>();
  for (const row of salesRows()) {
    const key = `${row.tenantId}|${row.periodStart}|${row.territory}|${row.brand}`;
    const group = groups.get(key) ?? { trx: 0, prescribers: new Set<string>() };
    group.trx += row.trx;
    group.prescribers.add(row.prescriber);
    groups.set(key, group);
  }
  const small = [...groups].filter(([, group]) => group.prescribers.size < SMALL_GROUP).map(([key]) => key);
  assert.ok(small.length >= 3, "the dataset plants three small groups");
  for (const tenant of Object.keys(TENANTS)) {
    const result = await runQuery("SELECT period_start::text AS p, territory, brand, trx, prescribers FROM bi.territory_rx", tenant, url);
    assert.ok(result.ok);
    const published = new Map(result.rows.map((row) => [`${tenant}|${row.p}|${row.territory}|${row.brand}`, row]));
    for (const [key, group] of groups) {
      if (!key.startsWith(`${tenant}|`)) continue;
      const row = published.get(key);
      if (group.prescribers.size < SMALL_GROUP) assert.equal(row, undefined, `${key} has ${group.prescribers.size} prescribers and was published`);
      else assert.deepEqual([row?.trx, row?.prescribers], [group.trx, group.prescribers.size], key);
    }
  }
});

test("a date comes back as the day Postgres holds, in any time zone", async () => {
  const result = await runQuery("SELECT DATE '2026-09-01' AS day, min(period_start) AS first FROM bi.territory_rx", "pharma_b", url);
  assert.ok(result.ok);
  assert.equal(result.rows[0].day, "2026-09-01");
  assert.match(String(result.rows[0].first), /^\d{4}-\d{2}-01$/);
});

test("an answer is cut at 500 rows", async () => {
  const result = await runQuery("SELECT a.territory FROM bi.territory_rx a, bi.territory_rx b", "pharma_a", url);
  assert.ok(result.ok);
  assert.equal(result.rows.length, 500);
  assert.equal(result.truncated, true);
});

test("the agent's list of columns is the published table's columns", async () => {
  const { rows } = await owner.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'bi' AND table_name = 'territory_rx' ORDER BY ordinal_position"
  );
  assert.deepEqual(
    rows.map((row) => [row.column_name, row.data_type]),
    COLUMNS.map(([name, type]) => [name, type])
  );
});
