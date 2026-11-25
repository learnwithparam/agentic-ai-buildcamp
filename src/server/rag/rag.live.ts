// Lesson 20, on the real embedding model through the gateway (npm run check:live).
// The Docling fixtures are real converter output, so no Docling runs here either.
import { resetSpans, spans, stopTracing } from "../../../scripts/live-spans";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { embed, EMBEDDING_MODEL } from "../gateway";
import { TODAY } from "../labels";
import type { DoclingDocument } from "./extract";
import { embeddingText, ingestLibrary, type ManifestDoc } from "./ingest";
import { MIN_SIMILARITY, vectorSearch } from "./search";
import { LabelChunkStore, type LabelChunk } from "./store";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doclingJson = (docId: string) =>
  JSON.parse(readFileSync(path.join(root, "src/server/rag/fixtures", `${docId}.docling.json`), "utf8")) as DoclingDocument;
const manifest = (JSON.parse(readFileSync(path.join(root, "data/hcp/pdf/manifest.json"), "utf8")) as { docs: ManifestDoc[] }).docs;
const docOf = (docId: string) => manifest.find((doc) => doc.doc_id === docId)!;

// The embed spans the gateway opened since the last reset: one per call to the model.
const embedCalls = async () => (await spans()).filter((span) => span.name === "embed").length;

test("ingest embeds a PDF once, skips it while unchanged, and never stores one that fails the check", async () => {
  const rows = new Map<string, { chunks: LabelChunk[]; sha: string; model: string }>();
  let kept: string[] | undefined;
  let texts = 0;
  const deps = {
    root,
    model: EMBEDDING_MODEL,
    store: {
      ingestedFrom: async (docId: string) => {
        const row = rows.get(docId);
        return row ? { pdfSha256: row.sha, model: row.model } : null;
      },
      replaceDocument: async (docId: string, chunks: LabelChunk[], sha: string, model: string) => void rows.set(docId, { chunks, sha, model }),
      keepOnly: async (docIds: string[]) => ((kept = docIds), 0)
    },
    convert: async (file: { name: string }) => doclingJson(file.name.startsWith("cardionex-uspi") ? "cardionex-uspi-v2" : "cardionex-clarion-hf-trial"),
    embed: async (batch: string[]) => ((texts += batch.length), embed(batch))
  };
  const docs = [docOf("cardionex-uspi-v2"), docOf("cardionex-clarion-hf-trial")];

  resetSpans();
  const first = await ingestLibrary(docs, deps);
  assert.deepEqual(first.map((r) => r.outcome), ["stored", "stored"]);
  const stored = rows.get("cardionex-uspi-v2")!.chunks.length + rows.get("cardionex-clarion-hf-trial")!.chunks.length;
  assert.equal(texts, stored);
  assert.ok(rows.get("cardionex-uspi-v2")!.chunks.every((chunk) => chunk.embedding.length === 1536));
  assert.equal(rows.get("cardionex-uspi-v2")!.chunks[0].tenantId, "pharma_a");
  assert.deepEqual(kept, ["cardionex-uspi-v2", "cardionex-clarion-hf-trial"]);
  const calls = await embedCalls();
  assert.ok(calls >= 1);

  const second = await ingestLibrary(docs, deps);
  assert.deepEqual(second.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.equal(await embedCalls(), calls, "an unchanged PDF makes no model call");

  // Docling's row-by-row reading of CLARION-HF, as before the column fix: not stored, nothing removed.
  rows.clear();
  kept = undefined;
  const broken = { ...deps, convert: async () => ({ body: { children: [] }, groups: [], texts: [], tables: [], pages: {} }) as DoclingDocument };
  const failed = await ingestLibrary([docOf("cardionex-clarion-hf-trial")], broken);
  assert.equal(failed[0].outcome, "failed");
  assert.equal(rows.size, 0);
  assert.equal(kept, undefined, "a failed run removes nothing from the index");
  assert.equal(await embedCalls(), calls, "a PDF that fails the check is never embedded");
});

// --- The pgvector store, against the tests' own Postgres, with real vectors.
if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const store = new LabelChunkStore(pool);
const SECTIONS = [
  { docId: "test-rag-a", tenantId: "pharma_a", section: "8.2", title: "Lactation", text: "Do not breastfeed while taking this medicine." },
  { docId: "test-rag-a", tenantId: "pharma_a", section: "2.2", title: "Dosing", text: "Start at 20mg once daily." },
  { docId: "test-rag-b", tenantId: "pharma_b", section: "8.2", title: "Lactation", text: "Breastfeed only while taking the lowest dose." },
  { docId: "test-rag-b", tenantId: "pharma_b", section: "5.1", title: "Warnings", text: "Low blood pressure." }
];
const chunks = new Map<string, LabelChunk>();
const search = vectorSearch(store, async (text) => (await embed([text]))[0], MIN_SIMILARITY, EMBEDDING_MODEL);

before(async () => {
  await migrate(pool);
  const vectors = await embed(SECTIONS.map(embeddingText));
  SECTIONS.forEach((s, i) =>
    chunks.set(`${s.docId} ${s.section}`, { ...s, brandId: "brand_test", status: "active", effectiveDate: "2026-01-01", country: "US", embedding: vectors[i] })
  );
  const of = (key: string) => chunks.get(key)!;
  await store.replaceDocument("test-rag-a", [of("test-rag-a 8.2"), of("test-rag-a 2.2")], "sha-a", EMBEDDING_MODEL);
  await store.replaceDocument("test-rag-b", [of("test-rag-b 8.2")], "sha-b", EMBEDDING_MODEL);
});
after(async () => {
  await pool.query("DELETE FROM label_chunks WHERE doc_id LIKE 'test-rag-%'");
  await pool.end();
  await stopTracing();
});

test("the nearest section comes first, among the documents the asker may read only", async () => {
  const hits = await search("can I breastfeed while taking it", new Set(["test-rag-a"]), 4, TODAY);
  assert.equal(`${hits[0]?.docId} ${hits[0]?.section}`, "test-rag-a 8.2");
  const other = await search("can I breastfeed while taking it", new Set(["test-rag-b"]), 4, TODAY);
  assert.deepEqual([...new Set(other.map((hit) => hit.docId))], ["test-rag-b"], "the filter is in the query, so pharma_a's rows are never candidates");
  assert.deepEqual(await search("breastfeed", new Set(), 4, TODAY), []);
});

test("a section below the similarity floor is not returned", async () => {
  assert.deepEqual(await search("What is the weather in Lisbon this weekend?", new Set(["test-rag-a", "test-rag-b"]), 4, TODAY), []);
});

test("re-ingesting a document replaces its sections, and a vector from another model is never compared", async () => {
  assert.deepEqual(await store.ingestedFrom("test-rag-b"), { pdfSha256: "sha-b", model: EMBEDDING_MODEL });
  assert.equal(await store.count("another-model"), 0);
  assert.deepEqual(await store.nearest(chunks.get("test-rag-a 8.2")!.embedding, ["test-rag-a"], 4, "another-model"), []);
  await store.replaceDocument("test-rag-b", [chunks.get("test-rag-b 5.1")!], "sha-b2", EMBEDDING_MODEL);
  const { rows } = await pool.query("SELECT section FROM label_chunks WHERE doc_id = 'test-rag-b'");
  assert.deepEqual(rows.map((row) => row.section), ["5.1"]);
});

test("a section in force comes before closer versions that are no longer in force", async () => {
  const older = "Severe renal impairment: give 10mg once daily.";
  // Three versions, as the CardioNex label has: v1 and v2 superseded, the new one in force.
  const docs = ["test-rag-old1", "test-rag-old2", "test-rag-old3", "test-rag-new"];
  const texts = [older, older, older, "Kidney disease, severe (eGFR under 30): 2.5mg once daily."];
  const vectors = await embed(texts);
  for (const [i, docId] of docs.entries()) {
    const status = docId === "test-rag-new" ? "active" : "superseded";
    const chunk: LabelChunk = { docId, tenantId: "pharma_a", brandId: "brand_test", section: "2.2", title: "Renal dosing", text: texts[i], status, effectiveDate: "2026-01-01", country: "US", embedding: vectors[i] };
    await store.replaceDocument(docId, [chunk], `sha-${docId}`, EMBEDDING_MODEL);
  }
  const query = "Severe renal impairment: what dose once daily?";
  const nearest = await store.nearest((await embed([query]))[0], docs, 1, EMBEDDING_MODEL);
  assert.notEqual(nearest[0]?.docId, "test-rag-new", "the setup needs an older version to be nearest");
  const hits = await search(query, new Set(docs), 1, TODAY);
  assert.deepEqual(hits.map((hit) => `${hit.docId} ${hit.status}`), ["test-rag-new active"]);
});
