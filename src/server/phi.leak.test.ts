import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool } from "./db";
import { env } from "./env";
import type { Identity } from "./users";

// Lesson 13. The three places an identifier could stay: the text the model reads, the trace, and
// the checkpoint in Postgres. One real turn through the real agent, with the real PostgresSaver and
// the real tracing; the question is one the lesson 10 door refuses, so no model is called. The
// model step (the finder) is a function that names one more person, so the test covers what it adds.

process.env.OPENAI_API_KEY ||= "not-used-by-this-test";
if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const SCHEMA = "langgraph_phi_test";
const pool = createPool(env.testDatabaseUrl);
const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
before(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});
after(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  await sdk.shutdown();
});
const { createMedinfoAgent } = await import("./medinfo-agent");

const user: Identity = { userId: "kc-okafor", name: "Chidi Okafor", email: "chidi.okafor@pharma-b.example.com", tenantId: "pharma_b", country: "US", roles: [] };

const IDENTIFIERS = ["Hanna Keller", "14/03/1951", "A-448210", "(415) 555-0132", "221 Maple Street, Springfield, IL 62704", "hk.keller@example.org", "078-05-1120", "Zelda Quimby"];
const QUESTION =
  "Write a Python script for my patient Hanna Keller, DOB 14/03/1951, MRN A-448210, phone (415) 555-0132, who lives at 221 Maple Street, Springfield, IL 62704, " +
  "email hk.keller@example.org, ID 078-05-1120. The neighbour Zelda Quimby drove her.";

async function checkpointText(): Promise<string> {
  const tables = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [SCHEMA]);
  const parts: string[] = [];
  for (const { table_name } of tables.rows) {
    const rows = await pool.query<{ row: string }>(`SELECT t::text AS row FROM ${SCHEMA}."${table_name}" t`);
    parts.push(...rows.rows.map((r) => r.row));
    // bytea columns print as hex in ::text, so read them as text too
    const bytea = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND data_type = 'bytea'", [SCHEMA, table_name]);
    for (const { column_name } of bytea.rows) {
      const raw = await pool.query<{ value: string }>(`SELECT convert_from("${column_name}", 'UTF8') AS value FROM ${SCHEMA}."${table_name}" WHERE "${column_name}" IS NOT NULL`);
      parts.push(...raw.rows.map((r) => r.value));
    }
  }
  return parts.join("\n");
}

test("no identifier reaches the checkpoint or the trace, the doctor reads their own words, and a second turn reuses the placeholders", async () => {
  const saver = new PostgresSaver(pool, undefined, { schema: SCHEMA });
  await saver.setup();
  const agent = createMedinfoAgent(saver, { phiFinder: async () => [{ text: "Zelda Quimby", type: "name" }] });
  const threadId = crypto.randomUUID();
  const sent: unknown[] = [];

  await agent.runTurn({ threadId, user, messages: [{ id: "q1", type: "human", content: QUESTION }] }, (event) => sent.push(event));
  await agent.runTurn({ threadId, user, messages: [{ id: "q2", type: "human", content: "Write a Python script again. Keller is the patient, phone (415) 555-0132." }] }, (event) => sent.push(event));

  await processor.forceFlush();
  const trace = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
  const stored = await checkpointText();
  assert.ok(stored.length > 0 && trace.length > 0, "nothing was recorded");
  for (const identifier of IDENTIFIERS) {
    assert.ok(!stored.includes(identifier), `the checkpoint holds ${identifier}`);
    assert.ok(!trace.includes(identifier), `the trace holds ${identifier}`);
  }
  assert.match(stored, /\[PATIENT_1\]/);
  assert.match(stored, /\[PATIENT_2\]/);
  assert.match(trace, /\[PATIENT_1\]/);
  assert.match(stored, /\[PATIENT_1\] is the patient, phone \[PHONE_1\]/);

  // The doctor's screen: their own words, not placeholders.
  const shown = JSON.stringify(sent);
  assert.ok(shown.includes("Hanna Keller") && shown.includes("A-448210"));
  assert.ok(!/\[(?:PATIENT|DOB|MRN|PHONE|EMAIL|ADDRESS|ID)_\d+\]/.test(shown), "a placeholder reached the doctor");
  const thread = JSON.stringify(await agent.readThread(threadId));
  assert.ok(thread.includes("Hanna Keller"));
});
