// Loads the seeded SQL into Postgres. It drops what it made first, so a second run is safe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT } from "../../../scripts/seed";
import { rows } from "./db";

const OWNED_SCHEMAS = ["pharma_a", "pharma_b", "analytics"];
const OWNED_TABLES = ["prescribers", "people", "grants"];

// #region step:foundation
export async function loadSeed(): Promise<void> {
  for (const schema of OWNED_SCHEMAS) await rows(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const table of OWNED_TABLES) await rows(`DROP TABLE IF EXISTS ${table}`);
  await rows(readFileSync(join(OUTPUT, "sql", "seed.sql"), "utf8"));
}
// #stub
//~ // TODO(foundation): drop the old schemas and tables, then run .data/sql/seed.sql
//~ export async function loadSeed(): Promise<void> {}
// #endregion
