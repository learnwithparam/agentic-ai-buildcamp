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

// Runs the work as one transaction. If it fails, every change is undone.
export async function inTransaction<Result>(
  work: (run: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>) => Promise<Result>,
): Promise<Result> {
  const client = await openPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work((sql, values = []) => client.query(sql, values));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
