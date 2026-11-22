// The BI guard must stop every way to reach another tenant's data or a system table.
import { expect, test } from "bun:test";
import { guardQuery } from "../packages/core/src/bi";

const OWNER = "pharma_a";

const BAD_QUERIES = [
  "SELECT 1 FROM pharma_a.territory_rx_weekly, pharma_b.commercial_dispenses",
  'SELECT 1 FROM "pharma_b".commercial_dispenses',
  "SELECT (SELECT count(*) FROM pharma_b.commercial_dispenses) FROM pharma_a.territory_rx_weekly",
  "SELECT pg_read_file('/etc/passwd') FROM pharma_a.territory_rx_weekly",
  "SELECT current_setting('x') FROM pharma_a.territory_rx_weekly",
  "SELECT count(*) FROM information_schema.tables",
];

for (const sql of BAD_QUERIES) {
  test(`the guard refuses: ${sql}`, () => {
    expect(guardQuery(sql, OWNER)).toBeDefined();
  });
}

test("the guard allows a plain total in the tenant's own schema", () => {
  const sql = "SELECT territory, sum(units) FROM pharma_a.territory_rx_weekly GROUP BY territory";
  expect(guardQuery(sql, OWNER)).toBeUndefined();
});
