import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { EMBEDDING_DIMENSIONS } from "../gateway";
import { parseLabelDoc, TODAY } from "../labels";
import { missingFromExtraction, readingOrder, sectionsFromMarkdown, type DoclingDocument } from "./extract";
import { ingestLibrary, type ManifestDoc } from "./ingest";
import { MIN_SIMILARITY, vectorSearch } from "./search";
import { LabelChunkStore, type LabelChunk } from "./store";

// Lesson 20. No model calls and no Docling: the fixtures are Docling's real output for two of the
// PDFs (docling-serve v1.38.2), and a fake embedder stands in for the model in the vector tests.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = (name: string) => readFileSync(path.join(root, "src/server/rag/fixtures", name), "utf8");
const doclingJson = (docId: string) => JSON.parse(fixture(`${docId}.docling.json`)) as DoclingDocument;
const manifest = (JSON.parse(readFileSync(path.join(root, "data/hcp/pdf/manifest.json"), "utf8")) as { docs: ManifestDoc[] }).docs;
const docOf = (docId: string) => manifest.find((doc) => doc.doc_id === docId)!;
const sourceOf = (docId: string) => parseLabelDoc(readFileSync(path.join(root, docOf(docId).source), "utf8"));
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const section = (sections: Array<{ section: string; text: string }>, id: string) => sections.find((s) => s.section === id)?.text ?? "";

test("Docling's own Markdown files the CLARION-HF table under the wrong section, and the check says so", () => {
  const sections = sectionsFromMarkdown(fixture("cardionex-clarion-hf-trial.docling.md"));
  assert.ok(!words(section(sections, "3.1")).includes("142"), "3.1 should come out empty from Docling's row-by-row Markdown");
  assert.ok(missingFromExtraction(sourceOf("cardionex-clarion-hf-trial"), sections).includes("section 3.1 lost words on the way out of the PDF"));
});

test("reading the boxes column by column keeps every word of both PDFs in its section", () => {
  for (const docId of ["cardionex-clarion-hf-trial", "cardionex-uspi-v2"]) {
    assert.deepEqual(missingFromExtraction(sourceOf(docId), sectionsFromMarkdown(readingOrder(doclingJson(docId)))), [], docId);
  }
});

test("the CLARION-HF efficacy table stays in 3.1 and the CYP3A4 footnote stays in 2.2", () => {
  const clarion = sectionsFromMarkdown(readingOrder(doclingJson("cardionex-clarion-hf-trial")));
  assert.ok(words(section(clarion, "3.1")).includes(words("Overall Intention-to-Treat (ITT) | 14.2% | 19.1%")));
  const v2 = sectionsFromMarkdown(readingOrder(doclingJson("cardionex-uspi-v2")));
  assert.ok(words(section(v2, "2.2")).includes(words("must NOT exceed 5mg once daily")));
  assert.ok(words(section(v2, "2.2")).includes(words("Co-administration with strong CYP3A4 inhibitors")));
});

test("a block lost on the way out of the PDF fails the check for its section", () => {
  const doc = doclingJson("cardionex-uspi-v2");
  const footnote = doc.texts.findIndex((text) => text.text.startsWith("Footnote *"));
  doc.body.children = doc.body.children.filter(({ $ref }) => $ref !== `#/texts/${footnote}`);
  const problems = missingFromExtraction(sourceOf("cardionex-uspi-v2"), sectionsFromMarkdown(readingOrder(doc)));
  assert.deepEqual(problems, ["section 2.2 lost words on the way out of the PDF"]);
});

// A stand-in for the model: each word adds to one of the vector's numbers, so texts that share
// words point the same way. Deterministic and free.
function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
    vector[hash] += 1;
  }
  return vector;
}

test("ingest stores a PDF once, skips it while unchanged, and never stores one that fails the check", async () => {
  const rows = new Map<string, { chunks: LabelChunk[]; sha: string; model: string }>();
  let kept: string[] | undefined;
  let embedded = 0;
  const deps = {
    root,
    model: "fake-model",
    store: {
      ingestedFrom: async (docId: string) => {
        const row = rows.get(docId);
        return row ? { pdfSha256: row.sha, model: row.model } : null;
      },
      replaceDocument: async (docId: string, chunks: LabelChunk[], sha: string, model: string) => void rows.set(docId, { chunks, sha, model }),
      keepOnly: async (docIds: string[]) => ((kept = docIds), 0)
    },
    convert: async (file: { name: string }) => doclingJson(file.name.startsWith("cardionex-uspi") ? "cardionex-uspi-v2" : "cardionex-clarion-hf-trial"),
    embed: async (texts: string[]) => ((embedded += texts.length), texts.map(fakeEmbed))
  };
  const docs = [docOf("cardionex-uspi-v2"), docOf("cardionex-clarion-hf-trial")];

  const first = await ingestLibrary(docs, deps);
  assert.deepEqual(first.map((r) => r.outcome), ["stored", "stored"]);
  assert.equal(embedded, rows.get("cardionex-uspi-v2")!.chunks.length + rows.get("cardionex-clarion-hf-trial")!.chunks.length);
  assert.equal(rows.get("cardionex-uspi-v2")!.chunks[0].tenantId, "pharma_a");
  assert.deepEqual(kept, ["cardionex-uspi-v2", "cardionex-clarion-hf-trial"]);

  const second = await ingestLibrary(docs, deps);
  assert.deepEqual(second.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.equal(embedded, first.reduce((n, r) => n + r.sections, 0), "an unchanged PDF makes no model call");

  // Docling's row-by-row reading of CLARION-HF, as before the column fix: not stored, nothing removed.
  rows.clear();
  kept = undefined;
  const broken = { ...deps, convert: async () => ({ body: { children: [] }, groups: [], texts: [], tables: [], pages: {} }) as DoclingDocument };
  const failed = await ingestLibrary([docOf("cardionex-clarion-hf-trial")], broken);
  assert.equal(failed[0].outcome, "failed");
  assert.equal(rows.size, 0);
  assert.equal(kept, undefined, "a failed run removes nothing from the index");
});

// --- The pgvector store, against the tests' own Postgres.
if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const store = new LabelChunkStore(pool);
const MODEL = "test-fake-embedder";
const chunk = (docId: string, tenantId: string, sectionId: string, title: string, text: string): LabelChunk => ({
  docId, section: sectionId, title, text, tenantId, brandId: "brand_test", status: "active", effectiveDate: "2026-01-01", country: "US",
  embedding: fakeEmbed(`${title} ${text}`)
});

before(async () => {
  await migrate(pool);
  await store.replaceDocument("test-rag-a", [
    chunk("test-rag-a", "pharma_a", "8.2", "Lactation", "Do not breastfeed while taking this medicine."),
    chunk("test-rag-a", "pharma_a", "2.2", "Dosing", "Start at 20mg once daily.")
  ], "sha-a", MODEL);
  await store.replaceDocument("test-rag-b", [chunk("test-rag-b", "pharma_b", "8.2", "Lactation", "Breastfeed only while taking the lowest dose.")], "sha-b", MODEL);
});
after(async () => {
  await pool.query("DELETE FROM label_chunks WHERE doc_id LIKE 'test-rag-%'");
  await pool.end();
});

const search = vectorSearch(store, async (text) => fakeEmbed(text), MIN_SIMILARITY, MODEL);

test("the nearest section comes first, among the documents the asker may read only", async () => {
  const hits = await search("can I breastfeed while taking it", new Set(["test-rag-a"]), 4, TODAY);
  assert.deepEqual(hits.map((hit) => `${hit.docId} ${hit.section}`), ["test-rag-a 8.2"]);
  const other = await search("can I breastfeed while taking it", new Set(["test-rag-b"]), 4, TODAY);
  assert.deepEqual(other.map((hit) => hit.docId), ["test-rag-b"], "the filter is in the query, so pharma_a's rows are never candidates");
  assert.deepEqual(await search("breastfeed", new Set(), 4, TODAY), []);
});

test("a section below the similarity floor is not returned", async () => {
  assert.deepEqual(await search("zebra quartz", new Set(["test-rag-a", "test-rag-b"]), 4, TODAY), []);
});

test("re-ingesting a document replaces its sections, and a vector from another model is never compared", async () => {
  assert.deepEqual(await store.ingestedFrom("test-rag-b"), { pdfSha256: "sha-b", model: MODEL });
  assert.equal(await store.count("another-model"), 0);
  assert.deepEqual(await store.nearest(fakeEmbed("breastfeed"), ["test-rag-a"], 4, "another-model"), []);
  await store.replaceDocument("test-rag-b", [chunk("test-rag-b", "pharma_b", "5.1", "Warnings", "Low blood pressure.")], "sha-b2", MODEL);
  const { rows } = await pool.query("SELECT section FROM label_chunks WHERE doc_id = 'test-rag-b'");
  assert.deepEqual(rows.map((row) => row.section), ["5.1"]);
});
