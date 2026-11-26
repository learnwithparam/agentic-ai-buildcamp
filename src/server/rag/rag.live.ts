// Lesson 20, on the real embedding model through the gateway (npm run check:live).
// The ingest reads the real label PDFs in data/hcp/pdf.
import { resetSpans, spans, stopTracing } from "../../../scripts/live-spans";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { embed, EMBEDDING_MODEL } from "../gateway";
import { inForceDocuments, LABEL_SECTIONS, TODAY } from "../labels";
import { CHUNKER, passages, sectionPath } from "./chunk";
import { embeddingText, ingestLibrary, type ManifestDoc } from "./ingest";
import { gradePassages } from "./grade";
import { hybridSearch } from "./search";
import { LabelChunkStore, type LabelChunk } from "./store";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
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
        return row ? { pdfSha256: row.sha, model: row.model, chunker: CHUNKER } : null;
      },
      replaceDocument: async (docId: string, chunks: LabelChunk[], sha: string, model: string) => void rows.set(docId, { chunks, sha, model }),
      keepOnly: async (docIds: string[]) => ((kept = docIds), 0)
    },
    embed: async (batch: string[]) => ((texts += batch.length), embed(batch))
  };
  const docs = [docOf("cardionex-uspi-v2"), docOf("cardionex-clarion-hf-trial")];

  resetSpans();
  const first = await ingestLibrary(docs, deps);
  assert.deepEqual(first.map((r) => r.outcome), ["stored", "stored"]);
  const stored = rows.get("cardionex-uspi-v2")!.chunks.length + rows.get("cardionex-clarion-hf-trial")!.chunks.length;
  assert.equal(texts, stored, "one vector per passage");
  assert.ok(first.every((r) => r.passages >= r.sections), "a long section adds passages, never drops one");
  assert.ok(rows.get("cardionex-uspi-v2")!.chunks.every((chunk) => chunk.embedding.length === 1536));
  assert.equal(rows.get("cardionex-uspi-v2")!.chunks[0].tenantId, "pharma_a");
  assert.deepEqual(kept, ["cardionex-uspi-v2", "cardionex-clarion-hf-trial"]);
  const calls = await embedCalls();
  assert.ok(calls >= 1);

  const second = await ingestLibrary(docs, deps);
  assert.deepEqual(second.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.equal(await embedCalls(), calls, "an unchanged PDF makes no model call");

  // A reading that lost the text of CLARION-HF: not stored, nothing removed.
  rows.clear();
  kept = undefined;
  const broken = { ...deps, convert: async () => "## 1.1 Synopsis and Study Identifiers\n\nCLARION-HF" };
  const failed = await ingestLibrary([docOf("cardionex-clarion-hf-trial")], broken);
  assert.equal(failed[0].outcome, "failed");
  assert.equal(rows.size, 0);
  assert.equal(kept, undefined, "a failed run removes nothing from the index");
  assert.equal(await embedCalls(), calls, "a PDF that fails the check is never embedded");
});

// --- The store and the hybrid search, against the tests' own Postgres, with real vectors. Rows go
// in under a model name of their own, so the tests never touch the real index.
if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
const store = new LabelChunkStore(pool);
const MODEL = `live-test ${EMBEDDING_MODEL}`;

// One real label: the US CardioNex label in force today, every section, cut as ingest cuts it.
const us = [...inForceDocuments(new Set(LABEL_SECTIONS.map((s) => s.docId)), TODAY)].find((id) => id.startsWith("cardionex-uspi"))!;
const label = LABEL_SECTIONS.filter((s) => s.docId === us);
const lactation = label.find((s) => /lactation/i.test(s.title))!;

before(async () => {
  await migrate(pool);
  await pool.query("DELETE FROM label_chunks WHERE embedding_model = $1", [MODEL]);
  const rows = label.flatMap((section) => passages(section.text).map((text, part) => ({ ...section, text, part, path: sectionPath(section, label) })));
  const vectors = await embed(rows.map(embeddingText));
  await store.replaceDocument(us, rows.map((row, i) => ({ ...row, embedding: vectors[i] })), "sha-live", MODEL, CHUNKER);
});
after(async () => {
  await pool.query("DELETE FROM label_chunks WHERE embedding_model = $1", [MODEL]);
  await pool.end();
  await stopTracing();
});

const search = hybridSearch({ store, grade: gradePassages, model: MODEL });
const readable = new Set([us]);

test("a question with none of the label's words finds Lactation by meaning, graded as the answer", async () => {
  const hits = await search("Can a mother who is nursing her baby take CardioNex?", readable, 5, TODAY);
  assert.equal(hits[0]?.section, lactation.section);
  assert.ok((hits[0]?.scores?.grade ?? 0) >= 2);
});

test("a question the label does not answer returns nothing, though some section is always nearest", async () => {
  const nearest = await store.nearest((await embed(["Can a patient receive a live vaccine while on CardioNex?"]))[0], [us], 1, MODEL);
  assert.equal(nearest.length, 1, "the setup needs a nearest section, as every vector search has one");
  assert.deepEqual(await search("Can a patient receive a live vaccine while on CardioNex?", readable, 5, TODAY), []);
});

test("an exact number finds its section by words", async () => {
  const keyword = await store.keyword("ketoconazole", [us], 5, MODEL);
  assert.ok(keyword.length && keyword.every((hit) => /ketoconazole/i.test(hit.text)), "BM25 returns only passages with the word");
});

test("a vector from another model is never compared, and re-ingest replaces a document's passages", async () => {
  assert.deepEqual(await store.ingestedFrom(us).then((row) => row && { ...row }), { pdfSha256: "sha-live", model: MODEL, chunker: CHUNKER });
  assert.deepEqual(await store.nearest((await embed(["dose"]))[0], [us], 4, "another-model"), []);
  assert.deepEqual(await store.keyword("dose", [us], 4, "another-model"), []);
});
