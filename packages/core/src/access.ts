// Who may see what. The rule is written twice: as can() in code, and as a policy in the database.
// The agent asks can() first. The database is a second wall that holds even if the code is wrong.
import { BRANDS } from "../../../data/catalog/brands";
import type { DocumentType } from "../../../data/catalog/documents";
import { GRANTS, type Person, type Role } from "../../../data/catalog/people";
import { inTransaction, rows } from "./db";
import type { StoredDocument } from "./ingestion";

export type Tool = "documents" | "bi";
export type Resource = { brand: string; type: DocumentType };
export type Verdict = { allowed: boolean; reason: string };

const ALL_TERRITORIES = "all-territories";

// How high a person's clearance must be to read each kind of document.
export const CLEARANCE: [DocumentType, number][] = [
  ["label", 1],
  ["faq", 1],
  ["scanned-page", 1],
  ["two-column", 1],
  ["study-summary", 2],
  ["safety-letter", 2],
];

// Which tools each role may use. A role that is not listed may use none.
export const ROLE_TOOLS: [Role, Tool[]][] = [
  ["medical-affairs", ["documents", "bi"]],
  ["field-rep", ["documents"]],
  ["safety-officer", ["documents"]],
];

function clearanceOf(type: DocumentType): number {
  const found = CLEARANCE.find(([name]) => name === type);
  if (found === undefined) return 3;
  return found[1];
}

function ownerOf(brand: string): string {
  const found = BRANDS.find((item) => item.name === brand);
  if (found === undefined) return "nobody";
  return found.tenant;
}

// #region step:access-control
function carriesBrand(territory: string, brand: string): boolean {
  for (const grant of GRANTS) {
    if (grant.person === territory && grant.relation === "carries" && grant.object === brand)
      return true;
  }
  return false;
}

// Look at the areas this person covers.
function coversBrand(person: Person, brand: string): boolean {
  for (const grant of GRANTS) {
    if (grant.person !== person.name || grant.relation !== "covers") continue;
    if (grant.object === ALL_TERRITORIES || carriesBrand(grant.object, brand)) return true;
  }
  return false;
}

export function can(person: Person, resource: Resource): Verdict {
  if (ownerOf(resource.brand) !== person.tenant) {
    return { allowed: false, reason: "That belongs to another company." };
  }
  if (person.clearance < clearanceOf(resource.type)) {
    return { allowed: false, reason: "Your clearance is too low for that document." };
  }
  if (person.role === "field-rep" && !coversBrand(person, resource.brand)) {
    return { allowed: false, reason: "Your territories do not carry that brand." };
  }
  return { allowed: true, reason: "allowed" };
}

export function canUse(person: Person, tool: Tool): Verdict {
  for (const [role, tools] of ROLE_TOOLS) {
    if (role === person.role && tools.includes(tool)) return { allowed: true, reason: "allowed" };
  }
  return { allowed: false, reason: `Your role cannot use the ${tool} tool.` };
}

function caseOf(column: string, pairs: [string, string | number][], other: string): string {
  const lines = pairs.map(([name, value]) => `WHEN '${name}' THEN ${value}`);
  return `CASE ${column} ${lines.join(" ")} ELSE ${other} END`;
}

// The same rule as can(), for the database. It reads the same lists, so the two cannot drift.
export function wallFunction(): string {
  const owner = caseOf(
    "doc_brand",
    BRANDS.map((brand) => [brand.name, `'${brand.tenant}'`]),
    "''",
  );
  const needed = caseOf("doc_type", CLEARANCE, "3");
  return `CREATE OR REPLACE FUNCTION app_can_see(who text, doc_brand text, doc_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM people p WHERE p.name = who
    AND p.tenant = ${owner}
    AND p.clearance >= ${needed}
    AND (p.role <> 'field-rep' OR EXISTS (
      SELECT 1 FROM grants covers
      WHERE covers.person = p.name AND covers.relation = 'covers'
        AND (covers.object = '${ALL_TERRITORIES}' OR EXISTS (
          SELECT 1 FROM grants carries WHERE carries.person = covers.object
            AND carries.relation = 'carries' AND carries.object = doc_brand)))))
$$`;
}

const WALL_SETUP = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_reader') THEN
    CREATE ROLE app_reader;
  END IF;
END $$;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wall ON documents;
CREATE POLICY wall ON documents FOR SELECT TO app_reader
  USING (app_can_see(current_setting('app.person', true), brand, type));
GRANT SELECT ON documents TO app_reader`;

export async function applyWalls(): Promise<void> {
  await rows(wallFunction());
  await rows(WALL_SETUP);
}

// This query runs as the reader role. The policy picks the rows.
export async function readUnderWall(
  person: string,
  brand: string,
  country: string,
): Promise<StoredDocument[]> {
  return inTransaction(async (run) => {
    await run("SET LOCAL ROLE app_reader");
    await run("SELECT set_config('app.person', $1, true)", [person]);
    const found = await run(
      `SELECT slug, brand, country, body FROM documents
       WHERE is_active AND brand = $1 AND country = $2`,
      [brand, country],
    );
    return found.rows as StoredDocument[];
  });
}
// #stub
//~ // TODO(access-control): write can(), canUse(), the database wall and readUnderWall
//~ export function can(_person: Person, _resource: Resource): Verdict {
//~   return { allowed: true, reason: "allowed" };
//~ }
//~
//~ export function canUse(_person: Person, _tool: Tool): Verdict {
//~   return { allowed: true, reason: "allowed" };
//~ }
//~
//~ export async function applyWalls(): Promise<void> {}
//~
//~ export async function readUnderWall(
//~   _person: string,
//~   brand: string,
//~   country: string,
//~ ): Promise<StoredDocument[]> {
//~   const found = await rows<StoredDocument>(
//~     "SELECT slug, brand, country, body FROM documents "
//~       + "WHERE is_active AND brand = $1 AND country = $2",
//~     [brand, country],
//~   );
//~   return found;
//~ }
// #endregion
