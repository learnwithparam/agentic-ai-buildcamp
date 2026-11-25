import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { TENANTS } from "../users";

// Lesson 22. Loads the two vendor files into sales.prescriptions as sent, then builds the one table
// the insights agent reads, bi.territory_rx (migration 009). npm run bi:setup runs it; so does the
// database test, on the test database. A second run replaces the rows, so it is safe to repeat.

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/hcp/sql");

// A group of fewer prescribers than this is left out of bi.territory_rx. With 3 doctors in a cell,
// a total is close to one doctor's own numbers; 11 is the cut-off US health data rules use for
// small cells. The agent's prompt reads the same number, so it can say why a row is missing.
export const SMALL_GROUP = 11;

type Row = {
  tenantId: string;
  periodStart: string;
  grain: "week" | "month";
  territory: string;
  brand: string;
  prescriber: string;
  trx: number;
  nbrx: number | null;
  units: number | null;
};

function readCsv(file: string): Array<Record<string, string>> {
  const [header, ...lines] = readFileSync(path.join(SQL_DIR, file), "utf8").trim().split("\n");
  const names = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, at) => [names[at], value])));
}

// "brand_cardionex" in a vendor file is CardioNex in the company's own list of medicines.
function brandName(tenantId: string, code: string): string {
  const name = TENANTS[tenantId].medicines.find((medicine) => `brand_${medicine.toLowerCase()}` === code);
  if (!name) throw new Error(`${code} is not one of ${TENANTS[tenantId].name}'s medicines.`);
  return name;
}

// Each vendor's own shape, mapped column by column. Nothing is invented: Pharma B sends no new
// prescriptions, so nbrx stays empty for it, and its months stay months.
export function salesRows(): Row[] {
  const pharmaA = readCsv("pharma_a_territory_rx.csv").map((row) => ({
    tenantId: "pharma_a",
    periodStart: row.week_start,
    grain: "week" as const,
    territory: row.territory_code,
    brand: brandName("pharma_a", row.brand_code),
    prescriber: row.prescriber_npi,
    trx: Number(row.total_trx),
    nbrx: Number(row.nbrx_count),
    units: null
  }));
  const pharmaB = readCsv("pharma_b_dispenses.csv").map((row) => ({
    tenantId: "pharma_b",
    periodStart: `${row.dispense_month}-01`,
    grain: "month" as const,
    territory: row.region_id,
    brand: brandName("pharma_b", row.product_slug),
    prescriber: row.hcp_email,
    trx: Number(row.scripts_filled),
    nbrx: null,
    units: Number(row.units_shipped)
  }));
  return [...pharmaA, ...pharmaB];
}

export async function loadSales(pool: pg.Pool): Promise<{ rows: number; published: number }> {
  const rows = salesRows();
  const column = <K extends keyof Row>(key: K) => rows.map((row) => row[key]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE sales.prescriptions, bi.territory_rx");
    await client.query(
      `INSERT INTO sales.prescriptions (tenant_id, period_start, grain, territory, brand, prescriber, trx, nbrx, units)
       SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[])`,
      [column("tenantId"), column("periodStart"), column("grain"), column("territory"), column("brand"), column("prescriber"), column("trx"), column("nbrx"), column("units")]
    );
    const published = await client.query(
      `INSERT INTO bi.territory_rx (tenant_id, period_start, grain, territory, brand, trx, nbrx, units, prescribers)
       SELECT tenant_id, period_start, grain, territory, brand, sum(trx), sum(nbrx), sum(units), count(DISTINCT prescriber)
       FROM sales.prescriptions
       GROUP BY tenant_id, period_start, grain, territory, brand
       HAVING count(DISTINCT prescriber) >= $1`,
      [SMALL_GROUP]
    );
    await client.query("COMMIT");
    return { rows: rows.length, published: published.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
