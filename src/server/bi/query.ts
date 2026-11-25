import { parse } from "libpg-query";
import pg from "pg";
import { env } from "../env";

// Lesson 22. The one way the insights agent reads sales data. The model writes SQL; this decides
// whether it runs, and as whom. Three layers, each one enough on its own for some attacks:
//
// 1. The parser. Postgres's own parser (libpg-query) reads the SQL. It must be one SELECT that reads
//    only the published table and calls only functions on the list below. "Run only a SELECT" is not
//    enough: SELECT set_config('role', ...) is a SELECT, and so is SELECT pg_sleep(60).
// 2. The login. The query runs as bi_<company>, the company in the signed-in user's token. The row
//    rule in Postgres shows that login its own company's rows, whatever the SQL says.
// 3. The transaction. READ ONLY, a 3 second limit, and at most MAX_ROWS rows back.

export const PUBLISHED_TABLE = "territory_rx";
export const MAX_ROWS = 500;

// Aggregates, window functions, and date and number helpers. Nothing that reads files, changes a
// setting, sleeps, or reaches another table.
export const ALLOWED_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "stddev", "round", "abs", "floor", "ceil",
  "date_trunc", "date_part", "extract", "to_char", "make_date",
  "lag", "lead", "rank", "dense_rank", "row_number", "first_value", "last_value", "percent_rank",
  "string_agg", "nullif"
]);

export type QueryResult =
  | { ok: true; sql: string; columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }
  | { ok: false; sql: string; refused: string };

type Node = unknown;

// Every node of one kind, anywhere in the tree.
function* nodes(tree: Node, kind: string): Generator<Record<string, unknown>> {
  if (Array.isArray(tree)) {
    for (const item of tree) yield* nodes(item, kind);
  } else if (tree && typeof tree === "object") {
    for (const [key, value] of Object.entries(tree)) {
      if (key === kind) yield value as Record<string, unknown>;
      yield* nodes(value, kind);
    }
  }
}

const names = (list: unknown) => (list as Array<{ String: { sval: string } }>).map((part) => part.String.sval);

// Why the SQL may not run, or null when it may. Exported so the tests can feed it attacks directly.
export async function refusal(sql: string): Promise<string | null> {
  let tree: { stmts?: Array<{ stmt: Record<string, unknown> }> };
  try {
    tree = await parse(sql);
  } catch (error) {
    return `The SQL does not parse: ${(error as Error).message}`;
  }
  const statements = tree.stmts ?? [];
  if (statements.length !== 1) return `Send one statement, not ${statements.length}.`;
  const [kind] = Object.keys(statements[0].stmt);
  if (kind !== "SelectStmt") return `Only a SELECT may run, not ${kind.replace(/Stmt$/, "").toUpperCase()}.`;
  const select = statements[0].stmt;
  if ([...nodes(select, "intoClause")].length) return "SELECT INTO makes a table. Only reading is allowed.";
  if ([...nodes(select, "lockingClause")].length) return "FOR UPDATE and FOR SHARE lock rows. Only reading is allowed.";

  for (const call of nodes(select, "FuncCall")) {
    const name = names(call.funcname).at(-1)!.toLowerCase();
    if (!ALLOWED_FUNCTIONS.has(name)) return `The function ${name} is not on the allowed list.`;
  }
  // Names a WITH clause defines may be read like tables; every other table must be the published one.
  const defined = new Set([...nodes(select, "CommonTableExpr")].map((cte) => String(cte.ctename)));
  for (const table of nodes(select, "RangeVar")) {
    const schema = table.schemaname as string | undefined;
    const name = String(table.relname);
    if (schema === undefined && defined.has(name)) continue;
    if (name !== PUBLISHED_TABLE || (schema !== undefined && schema !== "bi")) {
      return `Only bi.${PUBLISHED_TABLE} may be read, not ${schema ? `${schema}.` : ""}${name}.`;
    }
  }
  return null;
}

// One pool per company login. Each holds few connections: the login allows 5 in all.
const pools = new Map<string, pg.Pool>();

export function biPool(tenantId: string, databaseUrl = env.databaseUrl): pg.Pool {
  const key = `${tenantId} ${databaseUrl}`;
  let pool = pools.get(key);
  if (!pool) {
    const password = env.biDbPassword(tenantId);
    if (!databaseUrl || !password) throw new Error(`The insights login for ${tenantId} is not configured. Run npm run identity:setup, then npm run bi:setup (lesson 22).`);
    const url = new URL(databaseUrl);
    url.username = `bi_${tenantId}`;
    url.password = password;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    pools.set(key, pool);
  }
  return pool;
}

export async function closeBiPools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}

export async function runQuery(sql: string, tenantId: string, databaseUrl?: string): Promise<QueryResult> {
  const text = sql.trim().replace(/;\s*$/, "");
  const refused = await refusal(text);
  if (refused) return { ok: false, sql: text, refused };
  const client = await biPool(tenantId, databaseUrl).connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3s'");
    // The new lines keep a trailing -- comment in the model's SQL from swallowing the wrapper.
    const result = await client.query(`SELECT * FROM (\n${text}\n) AS answer LIMIT ${MAX_ROWS + 1}`);
    return {
      ok: true,
      sql: text,
      columns: result.fields.map((field) => field.name),
      rows: result.rows.slice(0, MAX_ROWS),
      truncated: result.rows.length > MAX_ROWS
    };
  } catch (error) {
    return { ok: false, sql: text, refused: `Postgres refused it: ${(error as Error).message}` };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
