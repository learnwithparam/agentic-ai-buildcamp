// Reads each document PDF into text and keeps only the label that is in force today.
// A file that did not change is left alone. A new version takes the place of the old one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtractInputKind, extract } from "@xberg-io/xberg";
import { AS_OF } from "../../../data/catalog/brands";
import { DOCUMENTS, type HcpDocument } from "../../../data/catalog/documents";
import { OUTPUT } from "../../../scripts/seed";
import { applyWalls, readUnderWall } from "./access";
import { inTransaction, rows } from "./db";

export type Outcome = "added" | "replaced" | "unchanged_skipped";

export type StoredDocument = { slug: string; brand: string; country: string; body: string };

const COLUMNS = `slug text PRIMARY KEY, brand text, country text, type text, version int,
  effective date, expires date, content_sha text, body text, is_active boolean DEFAULT false`;

export async function resetDocuments(): Promise<void> {
  await rows("DROP TABLE IF EXISTS documents");
  await rows(`CREATE TABLE documents (${COLUMNS})`);
  await applyWalls();
}

function fileOf(document: HcpDocument): string {
  return join(OUTPUT, "documents", `${document.slug}.pdf`);
}

async function readText(file: string): Promise<string> {
  const result = await extract({ kind: ExtractInputKind.Uri, uri: file });
  const text = result.results?.[0]?.content ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function rowOf(document: HcpDocument, sha: string, body: string): unknown[] {
  const { slug, brand, country, type, version, effective } = document;
  return [slug, brand, country, type, version, effective, document.expires ?? null, sha, body];
}

// #region step:documents-freshness
const IN_FORCE = "o.effective <= $1 AND (o.expires IS NULL OR o.expires >= $1)";

// One label is active: the newest version that is in force today for its brand and country.
const REFRESH_ACTIVE = `UPDATE documents d SET is_active = (
  ${IN_FORCE.replaceAll("o.", "d.")} AND d.version = (
    SELECT max(o.version) FROM documents o
    WHERE o.brand = d.brand AND o.country = d.country AND o.type = d.type AND ${IN_FORCE}))
  WHERE brand = $2 AND country = $3 AND type = $4`;

export async function ingestDocument(document: HcpDocument): Promise<Outcome> {
  const bytes = readFileSync(fileOf(document));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const [known] = await rows<{ content_sha: string }>(
    "SELECT content_sha FROM documents WHERE slug = $1",
    [document.slug],
  );
  if (known !== undefined && known.content_sha === sha) return "unchanged_skipped";
  const values = rowOf(document, sha, await readText(fileOf(document)));
  await inTransaction(async (run) => {
    await run("DELETE FROM documents WHERE slug = $1", [document.slug]);
    await run("INSERT INTO documents VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)", values);
    const label = [AS_OF, document.brand, document.country, document.type];
    await run(REFRESH_ACTIVE, label);
  });
  return known === undefined ? "added" : "replaced";
}
// #stub
//~ // TODO(documents-freshness): skip unchanged files, store the text, mark one label active
//~ export async function ingestDocument(document: HcpDocument): Promise<Outcome> {
//~   return "added";
//~ }
// #endregion

export async function ingestAll(): Promise<void> {
  for (const document of DOCUMENTS) await ingestDocument(document);
}

// With a person, the database wall picks the documents.
export async function activeDocuments(
  brand: string,
  country: string,
  person?: string,
): Promise<StoredDocument[]> {
  if (person !== undefined) return readUnderWall(person, brand, country);
  return rows<StoredDocument>(
    `SELECT slug, brand, country, body FROM documents
     WHERE is_active AND brand = $1 AND country = $2`,
    [brand, country],
  );
}

type Stored = StoredDocument & { is_active: boolean };

export async function storedDocument(slug: string): Promise<Stored | undefined> {
  const found = await rows<Stored>(
    "SELECT slug, brand, country, body, is_active FROM documents WHERE slug = $1",
    [slug],
  );
  return found[0];
}
