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

// The dataset fixes "today" so every run sees the same labels in force. An event can name
// another day (lesson 16: a label comes into force), and the status below follows that day.
export const TODAY = "2026-11-23";

// Lesson 16. Which label text is in force is a fact about a day, not a fixed word in a file.
// A file's "approved" label comes into force on its effective date, and from that day the older
// versions of the same label (cardionex-uspi-v1, -v2, -v3: same company, medicine and country)
// are superseded. A file already marked superseded or expired stays so.
const family = (section: LabelSection) => `${section.tenantId}/${section.brandId}/${section.country}/${section.docId.replace(/-v\d+$/, "")}`;

export function statusOn(section: LabelSection, today: string): string {
  if (section.status === "superseded" || section.status === "expired") return section.status;
  if (section.effectiveDate > today) return section.status;
  const newer = LABEL_SECTIONS.some(
    (other) =>
      other.docId !== section.docId &&
      family(other) === family(section) &&
      (other.status === "active" || other.status === "approved") &&
      other.effectiveDate > section.effectiveDate &&
      other.effectiveDate <= today
  );
  return newer ? "superseded" : "active";
}

// The label a newer version replaced on that day, for example cardionex-uspi-v2 once v3 is in force.
export function replacedBy(docId: string, today: string): string | undefined {
  const doc = LABEL_SECTIONS.find((section) => section.docId === docId);
  if (!doc || statusOn(doc, today) !== "superseded") return undefined;
  return LABEL_SECTIONS.find((other) => family(other) === family(doc) && other.docId !== docId && statusOn(other, today) === "active")?.docId;
}

const STOPWORDS = new Set(
  "the and for who what how with not are was this that from your you can does should when which patient patients".split(" ")
);

const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !STOPWORDS.has(word));

// Scores every section by shared words, among the documents the asker may read. That set comes
// from OpenFGA (src/server/permissions.ts), never from the question. Each hit carries its
// status on the given day, so the agent sees which text is in force.
export function searchLabels(query: string, readable: ReadonlySet<string>, limit = 4, today = TODAY): LabelSection[] {
  const asked = new Set(words(query));
  return LABEL_SECTIONS.filter((section) => readable.has(section.docId))
    .map((section) => ({
      section,
      score: words(`${section.title} ${section.text}`).filter((word) => asked.has(word)).length
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({ ...hit.section, status: statusOn(hit.section, today) }));
}

// The countries where a company has label text in force, for the desk rules.
export function approvedCountries(tenantId: string, today = TODAY): string[] {
  const countries = LABEL_SECTIONS.filter((section) => section.tenantId === tenantId && statusOn(section, today) === "active").map(
    (section) => section.country
  );
  return [...new Set(countries)].sort();
}
