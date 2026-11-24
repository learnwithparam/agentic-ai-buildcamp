import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The app's own Postgres (infra/docker-compose.yml). Each file in src/server/migrations runs once,
// in name order, inside a transaction, and is recorded in schema_migrations.

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function createPool(connectionString: string) {
  if (!connectionString) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
  return new pg.Pool({ connectionString, max: 10 });
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    // One server at a time: a second process waits here instead of running the same file twice.
    await client.query("SELECT pg_advisory_lock(hashtext('medinfo_migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('medinfo_migrations'))").catch(() => {});
    client.release();
  }
}
