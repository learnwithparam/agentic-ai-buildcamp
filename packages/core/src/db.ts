// One place that opens the database. Every other file asks for rows from here.
import pg from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://buildcamp:buildcamp@localhost:5433/buildcamp";

let pool: pg.Pool | undefined;

function openPool(): pg.Pool {
  if (pool === undefined) pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  return pool;
}

export async function rows<Row extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const result = await openPool().query<Row>(sql, values);
  return result.rows;
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
