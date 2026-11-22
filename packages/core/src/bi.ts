// The BI tool lets the agent ask numbers questions. It never hands the agent raw people data.
// The agent first reads the table shapes. Then it writes one query. Code checks the query.
import type { AgentResult } from "../../../src/grade";
import { ask } from "./ask";
import { inTransaction, rows } from "./db";
import { type Tags, traced } from "./telemetry";

export type WriteQuery = (prompt: string) => Promise<string>;
export type TableShape = { table: string; columns: string[] };

const SCHEMA_OF_TENANT: Record<string, string> = {
  "pharma-a": "pharma_a",
  "pharma-b": "pharma_b",
};
const MAX_ROWS = 50;

export function schemaOf(tenantId: string): string {
  const found = SCHEMA_OF_TENANT[tenantId];
  if (found === undefined) throw new Error(`No data schema for tenant ${tenantId}.`);
  return found;
}

// The query can only read. A plain table name points at this tenant's own tables.
async function readOnlyIn(owner: string, sql: string): Promise<Record<string, unknown>[]> {
  return inTransaction(async (run) => {
    await run("SET TRANSACTION READ ONLY");
    await run(`SET LOCAL search_path = ${owner}`);
    return (await run(sql)).rows as Record<string, unknown>[];
  });
}

function refusal(text: string): AgentResult {
  return { route: "refuse", text, citations: [] };
}

// #region step:analytics-mcp
export async function inspectSchema(owner: string, tags: Tags): Promise<TableShape[]> {
  return traced("bi.inspect_schema", tags, async (setAttributes) => {
    const found = await rows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [owner],
    );
    const shapes: TableShape[] = [];
    for (const item of found) {
      const name = `${owner}.${item.table_name}`;
      const last = shapes[shapes.length - 1];
      if (last !== undefined && last.table === name) last.columns.push(item.column_name);
      else shapes.push({ table: name, columns: [item.column_name] });
    }
    setAttributes({ tables: shapes.length });
    return shapes;
  });
}

const TABLE_WORD = /\b(?:from|join)\s+([a-z0-9_.]+)/gi;
const PERSONAL_WORD = /\b(email|npi|name|prescribers?)\b/i;
const SCHEMA_WORD = /\b([a-z_][a-z0-9_]*)\s*\./gi;
const SYSTEM_WORD = /\b(pg_[a-z_]+|information_schema|current_setting|set_config|dblink)\b/i;

export function guardQuery(sql: string, owner: string): string | undefined {
  if (!/^\s*select\b/i.test(sql)) return "only select queries are allowed";
  if (sql.trim().replace(/;$/, "").includes(";")) return "only one statement is allowed";
  if (PERSONAL_WORD.test(sql)) return "personal data columns are not available";
  if (sql.includes('"')) return "quoted names are not allowed";
  if (SYSTEM_WORD.test(sql)) return "system tables and functions are not allowed";
  const schemas = [...sql.matchAll(SCHEMA_WORD)].map((match) => match[1].toLowerCase());
  const stray = schemas.find((schema) => schema !== owner);
  if (stray !== undefined) return `the schema ${stray} is outside this workspace`;
  const tables = [...sql.matchAll(TABLE_WORD)].map((match) => match[1].toLowerCase());
  if (tables.length === 0) return "the query reads no table";
  return undefined;
}

export function schemaPrompt(question: string, shapes: TableShape[]): string {
  const tables = shapes.map((shape) => `${shape.table}(${shape.columns.join(", ")})`);
  const rules = "Write one Postgres select query that answers the question. Use only these tables.";
  return [rules, tables.join("\n"), `Question: ${question}`].join("\n\n");
}

function sentenceOf(result: Record<string, unknown>[]): string {
  if (result.length === 0) return "The query found no rows.";
  const lines = result.map((row) => {
    const pairs = Object.entries(row).map(([name, value]) => `${name}: ${value}`);
    return pairs.join(", ");
  });
  return lines.join("\n");
}

export async function answerData(
  question: string,
  tenantId: string,
  tags: Tags,
  writeQuery: WriteQuery,
): Promise<AgentResult> {
  const owner = schemaOf(tenantId);
  const shapes = await inspectSchema(owner, tags);
  const sql = (await writeQuery(schemaPrompt(question, shapes))).trim();
  const problem = guardQuery(sql, owner);
  if (problem !== undefined) return refusal(`I cannot run that query: ${problem}.`);
  const found = await traced("bi.query", tags, async (setAttributes) => {
    const limited = `SELECT * FROM (${sql.replace(/;$/, "")}) AS answer LIMIT ${MAX_ROWS}`;
    const result = await readOnlyIn(owner, limited);
    setAttributes({ sql, row_count: result.length });
    return result;
  });
  return { route: "answer", text: sentenceOf(found), citations: [owner] };
}
// #stub
//~ // TODO(analytics-mcp): read the table shapes, check the query, return only the numbers
//~ export async function inspectSchema(_owner: string, _tags: Tags): Promise<TableShape[]> {
//~   return [];
//~ }
//~
//~ export function guardQuery(_sql: string, _owner: string): string | undefined {
//~   return undefined;
//~ }
//~
//~ export function schemaPrompt(question: string, _shapes: TableShape[]): string {
//~   return question;
//~ }
//~
//~ export async function answerData(
//~   _question: string,
//~   _tenantId: string,
//~   _tags: Tags,
//~   _writeQuery: WriteQuery,
//~ ): Promise<AgentResult> {
//~   return refusal("The BI tool is not built yet.");
//~ }
// #endregion

// The real agent: the same guard, with a live model that writes the query.
export async function dataAgent(question: string, tenantId: string): Promise<AgentResult> {
  const tags = { tenantId, agentName: "data-agent" };
  const writeQuery: WriteQuery = async (prompt) => (await ask("smart", prompt, tags)).text;
  return answerData(question, tenantId, tags, writeQuery);
}
