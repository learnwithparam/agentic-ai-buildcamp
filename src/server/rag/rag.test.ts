import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { EMBEDDING_DIMENSIONS } from "../gateway";
import { inForceDocuments, LABEL_SECTIONS, parseLabelDoc, TODAY, type LabelSection } from "../labels";
import { passages, sectionPath } from "./chunk";
import { missingFromExtraction, pdfToMarkdown, sectionsFromMarkdown } from "./extract";
import type { ManifestDoc } from "./ingest";
import { GradeCountError, retryOnMiscount } from "./grade";
import { candidatePool, fuse, hybridSearch } from "./search";
import { LabelChunkStore, type LabelChunk } from "./store";

// Lesson 20. No model calls: the extraction tests read the real label PDFs in data/hcp/pdf. The
// ingest and vector-search tests use the real embedding model, so they are in rag.live.ts
// (npm run check:live).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = (JSON.parse(readFileSync(path.join(root, "data/hcp/pdf/manifest.json"), "utf8")) as { docs: ManifestDoc[] }).docs;
const docOf = (docId: string) => manifest.find((doc) => doc.doc_id === docId)!;
const sourceOf = (docId: string) => parseLabelDoc(readFileSync(path.join(root, docOf(docId).source), "utf8"));
const markdownOf = (docId: string) => pdfToMarkdown(new Uint8Array(readFileSync(path.join(root, docOf(docId).pdf))), docId);
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const section = (sections: Array<{ section: string; text: string }>, id: string) => sections.find((s) => s.section === id)?.text ?? "";

test("every word of every label PDF comes out in its own section", async () => {
  for (const doc of manifest) {
    assert.deepEqual(missingFromExtraction(sourceOf(doc.doc_id), sectionsFromMarkdown(await markdownOf(doc.doc_id))), [], doc.doc_id);
  }
});

test("the CLARION-HF efficacy table stays in 3.1 row by row, and the CYP3A4 row and its footnote stay in 2.2", async () => {
  const clarion = sectionsFromMarkdown(await markdownOf("cardionex-clarion-hf-trial"));
  assert.ok(section(clarion, "3.1").includes("| Overall Intention-to-Treat (ITT) | 14.2% | 19.1% | 0.74 (0.65–0.84) | p < 0.001 |"), "one table row is one line");
  const v2 = sectionsFromMarkdown(await markdownOf("cardionex-uspi-v2"));
  assert.ok(words(section(v2, "2.2")).includes(words("must NOT exceed 5mg once daily")));
  assert.ok(section(v2, "2.2").includes("| Co-administration with strong CYP3A4 inhibitors* | 5mg once daily |"));
});

test("a table that runs onto the next page is one table, its header written once", async () => {
  const table = section(sectionsFromMarkdown(await markdownOf("cardionex-clarion-hf-trial")), "3.6");
  assert.equal(table.match(/^\| Subgroup \|/gm)?.length, 1);
});

test("a numbered step keeps its number in front of its text", async () => {
  const steps = section(sectionsFromMarkdown(await markdownOf("cardionex-payer-formulary-2026")), "4.7");
  assert.match(steps, /^1\. Read the denial letter/m);
});

test("a block lost on the way out of the PDF fails the check for its section", async () => {
  const markdown = await markdownOf("cardionex-uspi-v2");
  const footnote = markdown.split("\n\n").find((block) => block.startsWith("Footnote *"));
  assert.ok(footnote, "the 2.2 footnote is its own paragraph");
  const problems = missingFromExtraction(sourceOf("cardionex-uspi-v2"), sectionsFromMarkdown(markdown.replace(footnote, "")));
  assert.deepEqual(problems, ["section 2.2 lost words on the way out of the PDF"]);
});

// One page, one line of text, no tags: what a scanner or a plain "print to PDF" makes.
const UNTAGGED = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
  "4 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 10 50 Td (2.2 Dose) Tj ET\nendstream endobj",
  "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF"
].join("\n");

test("an untagged PDF is refused, not read from positions", async () => {
  await assert.rejects(pdfToMarkdown(new TextEncoder().encode(UNTAGGED), "scan.pdf"), /scan\.pdf is not a tagged PDF/);
});

// Lesson 20, the hybrid search. A real Postgres (the test database), no model: the vectors are
// fixed, so the test decides what is near, and the grader is a function, so the test decides
// what answers.
const pool = createPool(env.testDatabaseUrl);
const store = new LabelChunkStore(pool);
const MODEL = "test-fixed-vectors";
// A vector that points one way: passages given the same axis are near each other.
const axis = (i: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, j) => (j === i ? 1 : 0));
const doc = { tenantId: "pharma_a", brandId: "brand_test", status: "active", effectiveDate: "2026-01-01", country: "US" };
const passage = (docId: string, sectionId: string, title: string, text: string, vector: number, part = 0): LabelChunk => ({
  ...doc, docId, section: sectionId, part, title, text, path: `${sectionId} ${title}`, embedding: axis(vector)
});

before(async () => {
  await migrate(pool);
  await pool.query("DELETE FROM label_chunks WHERE embedding_model = $1", [MODEL]);
  await store.replaceDocument("test-rag-a", [
    passage("test-rag-a", "2.2", "Renal impairment", "Reduce the dose to 5 mg once daily when eGFR is below 30.", 0),
    passage("test-rag-a", "7.1", "Strong CYP3A4 inhibitors", "Ketoconazole raises exposure. Do not exceed 5 mg once daily with ketoconazole.", 1),
    passage("test-rag-a", "8.2", "Lactation", "It is not known whether the drug passes into breast milk. Patients should not breastfeed.", 2),
    passage("test-rag-a", "6.1", "Adverse reactions", "Patients reported dizziness. Patients reported headache. Patients reported cough.", 3),
    passage("test-rag-a", "6.1", "Adverse reactions", "In patients over 65, dizziness was more common.", 3, 1)
  ], "sha", MODEL, "test");
});
after(async () => {
  await pool.query("DELETE FROM label_chunks WHERE embedding_model = $1", [MODEL]);
  await pool.end();
});

const docs = ["test-rag-a"];

test("BM25 ranks the passage with the rare word first, and counts the library, not the asker", async () => {
  const hits = await store.keyword("ketoconazole patients", docs, 5, MODEL);
  assert.equal(hits[0]?.section, "7.1", "the one passage that names ketoconazole outranks the three that say patients");
  // A word in every passage still scores, just below a rare one.
  assert.ok(hits.some((hit) => hit.section === "6.1"));
  // The same question from someone who may read nothing finds nothing.
  assert.deepEqual(await store.keyword("ketoconazole", [], 5, MODEL), []);
});

test("BM25 stems words, so dosing finds the passage that says dose", async () => {
  const hits = await store.keyword("dosing", docs, 5, MODEL);
  assert.deepEqual(hits.map((hit) => hit.section), ["2.2"]);
});

test("BM25 holds a long passage back: the same word once in a short passage scores higher", async () => {
  const hits = await store.keyword("dizziness", docs, 5, MODEL);
  assert.deepEqual(hits.map((hit) => [hit.section, hit.part]), [["6.1", 1], ["6.1", 0]]);
});

test("the passages near the question by meaning come back nearest first", async () => {
  const hits = await store.nearest(axis(2), docs, 2, MODEL);
  assert.equal(hits[0]?.section, "8.2");
  assert.equal(hits[0]?.score, 1);
});

test("fusion lifts a passage both searches found over one only one search found", () => {
  const p = (sectionId: string, part = 0) => ({ ...doc, docId: "d", section: sectionId, part, title: "", text: "", path: "", score: 0 });
  const fused = fuse([p("1"), p("2"), p("3")], [p("3"), p("4")]);
  assert.equal(fused[0]?.passage.section, "3", "found by both");
  assert.deepEqual(fused[0] && [fused[0].dense, fused[0].keyword], [3, 1]);
  // Two passages of one section become one candidate, at its best rank.
  assert.deepEqual(fuse([p("5", 0), p("5", 1)], []).map((entry) => [entry.passage.section, entry.passage.part]), [["5", 0]]);
});

test("each search's own best sections reach the grader, even when fusion ranks them past the cut", () => {
  const p = (sectionId: string) => ({ ...doc, docId: "d", section: sectionId, part: 0, title: "", text: "", path: "", score: 0 });
  // The live case: "nursing her baby" shares no word with 8.2 Lactation, which vectors rank
  // first. In one document BM25 matches nearly every passage on "take", so 40 sections are in
  // both lists, and each of them outscores a section only one search found.
  const both = Array.from({ length: 40 }, (_, i) => p(`s${i}`));
  const dense = [p("8.2"), ...both];
  assert.ok(!fuse(dense, both).slice(0, 30).some((entry) => entry.passage.section === "8.2"), "fusion alone cuts it");
  const pool = candidatePool(dense, both, 30);
  assert.equal(pool.length, 30);
  assert.ok(pool.some((entry) => entry.passage.section === "8.2"), "the vector search's first section is graded");
  assert.equal(pool[0]?.passage.section, "s0", "the pool keeps the fused order");
});

// What the search returns, with LABEL_SECTIONS standing in: a store that hands back real sections.
const real = LABEL_SECTIONS.find((section) => section.status === "active")!;
const ranked = (section: LabelSection) => ({ ...section, part: 0, path: `${section.section} ${section.title}`, score: 1 });
const fixedStore = (sections: LabelSection[]) => ({ nearest: async () => sections.map(ranked), keyword: async () => [] });

test("a search whose best section grades below 2 returns nothing: the library does not answer it", async () => {
  const search = hybridSearch({ store: fixedStore([real]), embedQuery: async () => [0], grade: async (_q, passages) => ({ grades: passages.map(() => 1), best: [] }) });
  assert.deepEqual(await search("Can a patient have a live vaccine?", new Set([real.docId]), 5, TODAY), []);
});

test("graded results come highest grade first, each with its ranks and grade", async () => {
  const two = LABEL_SECTIONS.filter((section) => section.docId === real.docId).slice(0, 2);
  const search = hybridSearch({ store: fixedStore(two), embedQuery: async () => [0], grade: async () => ({ grades: [2, 3], best: [] }) });
  const hits = await search("q", new Set([real.docId]), 5, TODAY);
  assert.deepEqual(hits.map((hit) => [hit.section, hit.score]), [[two[1].section, 3], [two[0].section, 2]]);
  assert.deepEqual(hits[0]?.scores, { fused: 0.0161, dense_rank: 2, grade: 3 });
});

test("among answers, the grader's best order wins over grade and search order", async () => {
  const three = LABEL_SECTIONS.filter((section) => section.docId === real.docId).slice(0, 3);
  // All three grade 3; the grader names the third as the most direct, then the first.
  const search = hybridSearch({ store: fixedStore(three), embedQuery: async () => [0], grade: async () => ({ grades: [3, 3, 3], best: [2, 0] }) });
  const hits = await search("q", new Set([real.docId]), 5, TODAY);
  assert.deepEqual(hits.map((hit) => hit.section), [three[2].section, three[0].section, three[1].section]);
});

test("the grader is told each passage's document, medicine, country and date in force, not only its section", async () => {
  const seen: string[] = [];
  const search = hybridSearch({
    store: fixedStore([real]),
    embedQuery: async () => [0],
    grade: async (_q, passages) => ({ grades: passages.map((passage) => (seen.push(passage.source), 0)), best: [] })
  });
  await search("How should NeuroVex be stopped?", new Set([real.docId]), 5, TODAY);
  assert.deepEqual(seen, [`${real.docId} (${real.brandId}, ${real.country}, in force from ${real.effectiveDate})`]);
});

test("a document not in force on the day is never searched", async () => {
  const asked: string[][] = [];
  const spy = { nearest: async (_v: number[], ids: string[]) => (asked.push(ids), []), keyword: async () => [] };
  const versions = new Set(LABEL_SECTIONS.filter((section) => section.docId.startsWith("cardionex-uspi")).map((section) => section.docId));
  await hybridSearch({ store: spy, embedQuery: async () => [0] })("dose", versions, 5, TODAY);
  assert.deepEqual(asked, [[...inForceDocuments(versions, TODAY)]]);
  assert.equal(asked[0]?.length, 1, "one US label version is in force on the day");
});

test("search_labels with no index connected fails instead of answering from word counts", async () => {
  // The default search, before connectLabelIndex. Called directly: executeTool asks OpenFGA first,
  // and CI has no OpenFGA.
  const { noLabelIndex } = await import("../tools");
  await assert.rejects(noLabelIndex("CardioNex dose", new Set(["cardionex-uspi-v2"]), 5, "2026-11-26"), /no label index/);
});

test("a long section becomes passages of whole paragraphs, and a table is never cut", () => {
  const paragraph = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const table = ["| Group | Rate |", "| --- | --- |", ...Array.from({ length: 60 }, (_, i) => `| arm ${i} | ${i}% of patients enrolled |`)].join("\n");
  const parts = passages([paragraph(200), paragraph(200), table, paragraph(50)].join("\n\n"));
  assert.equal(parts.length, 4);
  assert.ok(parts[2]?.startsWith("| Group") && parts[2].endsWith("| arm 59 | 59% of patients enrolled |"), "the table is one passage, header and every row");
  assert.deepEqual(passages("short text"), ["short text"]);
  assert.equal(sectionPath({ section: "5.3", title: "Hyperkalemia" }, [{ section: "5", title: "Warnings" }]), "5 Warnings > 5.3 Hyperkalemia");
});

test("a question about another country searches only the company's documents from that country", async () => {
  const { documentsIn } = await import("../tools");
  const company = new Set(["cardionex-uspi-v2", "cardionex-de-smpc", "cardionex-jp-label"]);
  assert.deepEqual([...documentsIn(company, "DE")], ["cardionex-de-smpc"]);
  assert.deepEqual([...documentsIn(company, "JP")], ["cardionex-jp-label"]);
  assert.deepEqual([...documentsIn(new Set(["neurovex-uspi-v1"]), "DE")], []);
});

test("a miscounted grade list is asked for once more, and a second miscount fails the search", async () => {
  const passages = [{ source: "d", path: "1", text: "t" }];
  let calls = 0;
  const flaky = retryOnMiscount(async () => {
    calls++;
    if (calls === 1) throw new GradeCountError("2 grades for 1 passage");
    return { grades: [3], best: [0] };
  });
  assert.deepEqual(await flaky("q", passages), { grades: [3], best: [0] });
  assert.equal(calls, 2);
  const broken = retryOnMiscount(async () => { throw new GradeCountError("always wrong"); });
  await assert.rejects(broken("q", passages), GradeCountError);
  const other = retryOnMiscount(async () => { calls++; throw new Error("gateway down"); });
  calls = 0;
  await assert.rejects(other("q", passages), /gateway down/);
  assert.equal(calls, 1);
});
