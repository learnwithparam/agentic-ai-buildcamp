import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseLabelDoc } from "../labels";
import { CHUNKER, passages, sectionPath } from "./chunk";
import { missingFromExtraction, pdfToMarkdown, sectionsFromMarkdown } from "./extract";
import type { LabelChunk, LabelChunkStore } from "./store";

// Lesson 20. PDFs in, vectors out. For each PDF the company sent (data/hcp/pdf/manifest.json):
// its tags are read in the order the label was written (src/server/rag/extract.ts), every word is checked against
// the text the PDF was printed from, and each section is cut into passages (src/server/rag/chunk.ts),
// one row each with its vector. A PDF that fails the check is not stored: a section with a missing
// footnote would answer with half a dose.

export type ManifestDoc = {
  doc_id: string;
  tenant_id: string;
  brand_id: string;
  status: string;
  effective_date: string;
  country: string;
  pdf: string;
  source: string;
};

export type IngestDeps = {
  root: string;
  store: Pick<LabelChunkStore, "ingestedFrom" | "replaceDocument" | "keepOnly">;
  // The PDF as Markdown. pdfToMarkdown unless a test hands in its own.
  convert?: (file: { name: string; bytes: Uint8Array }) => Promise<string>;
  embed: (texts: string[]) => Promise<number[][]>;
  model: string;
  log?: (line: string) => void;
};

export type IngestResult = { docId: string; outcome: "stored" | "unchanged" | "failed"; sections: number; passages: number; problems: string[] };

// The text a passage's vector is made from. Its headings are part of it, so "lactation" finds
// 8.2 even where the body only says "breast milk", and the second half of a long warning still
// says which warning it is.
export const embeddingText = (chunk: Pick<LabelChunk, "docId" | "path" | "text">) => `${chunk.docId} ${chunk.path}\n${chunk.text}`;

export async function ingestLibrary(docs: ManifestDoc[], deps: IngestDeps): Promise<IngestResult[]> {
  const log = deps.log ?? (() => {});
  const results: IngestResult[] = [];
  for (const doc of docs) {
    const bytes = readFileSync(path.join(deps.root, doc.pdf));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const stored = await deps.store.ingestedFrom(doc.doc_id);
    if (stored?.pdfSha256 === sha && stored.model === deps.model && stored.chunker === CHUNKER) {
      results.push({ docId: doc.doc_id, outcome: "unchanged", sections: 0, passages: 0, problems: [] });
      log(`${doc.doc_id}: unchanged`);
      continue;
    }
    const convert = deps.convert ?? ((file) => pdfToMarkdown(file.bytes, file.name));
    const sections = sectionsFromMarkdown(await convert({ name: path.basename(doc.pdf), bytes }));
    const problems = missingFromExtraction(parseLabelDoc(readFileSync(path.join(deps.root, doc.source), "utf8")), sections);
    if (problems.length) {
      results.push({ docId: doc.doc_id, outcome: "failed", sections: sections.length, passages: 0, problems });
      log(`${doc.doc_id}: not stored, ${problems.join("; ")}`);
      continue;
    }
    const meta = { docId: doc.doc_id, tenantId: doc.tenant_id, brandId: doc.brand_id, status: doc.status, effectiveDate: doc.effective_date, country: doc.country };
    const chunks = sections.flatMap((section) =>
      passages(section.text).map((text, part) => ({ ...meta, ...section, text, part, path: sectionPath(section, sections) }))
    );
    const vectors = await deps.embed(chunks.map(embeddingText));
    await deps.store.replaceDocument(doc.doc_id, chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i] })), sha, deps.model, CHUNKER);
    results.push({ docId: doc.doc_id, outcome: "stored", sections: sections.length, passages: chunks.length, problems: [] });
    log(`${doc.doc_id}: ${sections.length} ${sections.length === 1 ? "section" : "sections"} stored as ${chunks.length} ${chunks.length === 1 ? "passage" : "passages"}`);
  }
  // Only once every PDF is read: a failed run never empties the index of what it could not replace.
  if (results.every((result) => result.outcome !== "failed")) {
    const removed = await deps.store.keepOnly(docs.map((doc) => doc.doc_id));
    if (removed) log(`${removed} passages of documents no longer in the library removed`);
  }
  return results;
}
