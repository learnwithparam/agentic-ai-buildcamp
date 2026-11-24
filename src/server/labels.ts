import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The label library: the dataset repo's HCP documents, copied into data/hcp/docs
// by scripts/sync-dataset.ts. Each "## 2.2 Title" heading is one searchable section.

export type LabelSection = {
  docId: string;
  section: string;
  title: string;
  text: string;
  tenantId: string;
  brandId: string;
  status: string;
  effectiveDate: string;
  country: string;
};

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/hcp/docs");

function parseDoc(raw: string): LabelSection[] {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return [];
  const meta = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
  return match[2]
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [heading, ...body] = block.split("\n");
      const [section, ...title] = heading.trim().split(" ");
      return {
        docId: meta.doc_id,
        section,
        title: title.join(" "),
        text: body.join("\n").trim(),
        tenantId: meta.tenant_id,
        brandId: meta.brand_id,
        status: meta.status,
        effectiveDate: meta.effective_date,
        country: meta.country
      };
    });
}

export const LABEL_SECTIONS: LabelSection[] = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .flatMap((name) => parseDoc(readFileSync(path.join(DOCS_DIR, name), "utf8")));

const STOPWORDS = new Set(
  "the and for who what how with not are was this that from your you can does should when which patient patients".split(" ")
);

const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !STOPWORDS.has(word));

// Naive on purpose: it scores every section by shared words and never looks at
// status, date, company or country. Later chapters fix each of those gaps.
export function searchLabels(query: string, limit = 4): LabelSection[] {
  const asked = new Set(words(query));
  return LABEL_SECTIONS.map((section) => ({
    section,
    score: words(`${section.title} ${section.text}`).filter((word) => asked.has(word)).length
  }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.section);
}
