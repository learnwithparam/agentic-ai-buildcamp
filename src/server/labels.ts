import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The label library: the dataset repo's HCP documents, copied into data/hcp by
// scripts/sync-dataset.ts. Each document is read from its full label in data/hcp/labels, the
// text the label PDFs are printed from, or from its short excerpt in data/hcp/docs when it has no
// full label. Each "## 2.2 Title" heading is one section.

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
  // Fix 4. The vector search's cosine similarity, so a reader can see why a section was found.
  // Word search and a short document's extra sections have none.
  score?: number;
};

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/hcp");
const DOCS_DIR = path.join(DATA_DIR, "docs");
const LABELS_DIR = path.join(DATA_DIR, "labels");

export function parseLabelDoc(raw: string): LabelSection[] {
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
  .flatMap((name) => {
    const full = path.join(LABELS_DIR, name);
    return parseLabelDoc(readFileSync(existsSync(full) ? full : path.join(DOCS_DIR, name), "utf8"));
  });

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

// Fix 0. The lookups behind the desk's label tools (src/server/tools.ts). Each takes the documents
// the asker may read, from OpenFGA, and never looks past them.

// "CardioNex" -> "brand_cardionex", the brand id in each document's front matter.
export const brandId = (medicine: string) => `brand_${medicine.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

// A prescribing label, as opposed to a trial summary, the FAQ, the formulary or the SOP.
const isLabel = (docId: string) => /(uspi|smpc|label|draft)/.test(docId);

function documents(readable: ReadonlySet<string>) {
  const byId = new Map<string, LabelSection>();
  for (const section of LABEL_SECTIONS) if (readable.has(section.docId) && !byId.has(section.docId)) byId.set(section.docId, section);
  return [...byId.values()];
}

export function readSection(docId: string, section: string, readable: ReadonlySet<string>, today = TODAY) {
  const hit = LABEL_SECTIONS.find((each) => readable.has(each.docId) && each.docId === docId && each.section === section);
  return hit && { ...hit, status: statusOn(hit, today) };
}

// Why a version has the status it has on that day, in words a doctor can check.
function versionReason(doc: LabelSection, today: string): string {
  const status = statusOn(doc, today);
  if (status === "active") return `in force since ${doc.effectiveDate}`;
  if (status === "superseded") {
    const newer = replacedBy(doc.docId, today);
    const since = newer && LABEL_SECTIONS.find((each) => each.docId === newer)?.effectiveDate;
    return newer ? `replaced by ${newer} on ${since}` : "replaced by a newer version";
  }
  if (status === "approved") return `approved, in force from ${doc.effectiveDate}`;
  if (status === "draft") return "a draft, never in force";
  return status;
}

export function labelVersions(medicine: string, country: string, readable: ReadonlySet<string>, today = TODAY) {
  return documents(readable)
    .filter((doc) => doc.brandId === brandId(medicine) && doc.country === country.toUpperCase() && isLabel(doc.docId))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .map((doc) => ({ docId: doc.docId, status: statusOn(doc, today), effectiveDate: doc.effectiveDate, reason: versionReason(doc, today) }));
}

// The one label of a medicine in force in a country on that day, if there is one.
export function labelInForce(medicine: string, country: string, readable: ReadonlySet<string>, today = TODAY) {
  return labelVersions(medicine, country, readable, today).find((version) => version.status === "active")?.docId;
}

const sectionsOf = (docId: string, today: string) =>
  LABEL_SECTIONS.filter((section) => section.docId === docId).map((section) => ({ ...section, status: statusOn(section, today) }));

// Where a medicine is approved, and for what: the use sections of the label in force there.
export function approvalStatus(medicine: string, country: string, readable: ReadonlySet<string>, today = TODAY) {
  const docId = labelInForce(medicine, country, readable, today);
  const uses = docId ? sectionsOf(docId, today).filter((section) => /indication|approved use|not approved/i.test(section.title)) : [];
  return { approved: Boolean(docId), docId, uses };
}

// Every section of the label in force that names the other drug, then the interaction sections.
export function checkInteraction(medicine: string, otherDrug: string, country: string, readable: ReadonlySet<string>, today = TODAY) {
  const docId = labelInForce(medicine, country, readable, today);
  if (!docId) return { docId, named: false, sections: [] };
  const drug = otherDrug.trim().toLowerCase();
  const all = sectionsOf(docId, today);
  const naming = all.filter((section) => drug.length > 2 && `${section.title} ${section.text}`.toLowerCase().includes(drug));
  const interactions = all.filter((section) => /^7\.|^4\.5$/.test(section.section) || /interaction/i.test(section.title));
  return { docId, named: naming.length > 0, sections: naming.length ? naming : interactions };
}

// The trial summary sections that best match the outcome asked about.
export function trialResults(medicine: string, endpoint: string, readable: ReadonlySet<string>, today = TODAY) {
  const trials = documents(readable).filter((doc) => doc.brandId === brandId(medicine) && doc.docId.includes("trial"));
  const asked = new Set(words(endpoint));
  return trials.flatMap((trial) => {
    const sections = sectionsOf(trial.docId, today);
    const scored = sections
      .map((section) => ({ section, score: words(`${section.title} ${section.text}`).filter((word) => asked.has(word)).length }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((hit) => hit.section);
    return scored.length ? scored.slice(0, 3) : sections;
  });
}
