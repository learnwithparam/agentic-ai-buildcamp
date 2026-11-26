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
// PDFs (docling-serve v1.38.2). The ingest and vector-search tests use the real embedding model,
// so they are in rag.live.ts (npm run check:live).

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
  assert.ok(!words(section(sections, "3.1")).includes("142"), "3.1 should not hold the efficacy table in Docling's row-by-row Markdown");
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

// Fix 4. No model and no database: a store that returns fixed scores, to show what search hands on.
test("each hit carries its score, and a section below the floor is not returned", async () => {
  const at = (sectionId: string, similarity: number) => ({
    docId: "test-a", section: sectionId, title: sectionId, text: "text", tenantId: "pharma_a", brandId: "brand_test",
    status: "active", effectiveDate: "2026-01-01", country: "US", similarity
  });
  const store = { nearest: async () => [at("2.2", 0.71234), at("8.7", 0.52), at("9.9", MIN_SIMILARITY - 0.01)], shortDocuments: async () => [] };
  const hits = await vectorSearch(store, async () => [0])("eGFR 24 dose", new Set(["test-a"]), 4, TODAY);
  assert.deepEqual(hits.map((hit) => [hit.section, hit.score]), [["2.2", 0.712], ["8.7", 0.52]]);
});

test("a question about another country searches only the company's documents from that country", async () => {
  const { documentsIn } = await import("../tools");
  const company = new Set(["cardionex-uspi-v2", "cardionex-de-smpc", "cardionex-jp-label"]);
  assert.deepEqual([...documentsIn(company, "DE")], ["cardionex-de-smpc"]);
  assert.deepEqual([...documentsIn(company, "JP")], ["cardionex-jp-label"]);
  assert.deepEqual([...documentsIn(new Set(["neurovex-uspi-v1"]), "DE")], []);
});
