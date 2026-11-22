// bun run distinct: no two units tell the same story, and every id is a readable name.
//
//   D1  no two units open on the same first question
//   D2  no text holds an opaque id such as H-1 or DOC-101
//   D3  every unit says what it becomes in production
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./root";
import { builtUnits, finish, type Loaded } from "./units";

// These look like ids but are not: they name a real standard the course teaches on purpose.
const ALLOWED = new Set(["SHA-256", "UTF-8", "ISO-8601"]);
const OPAQUE = /\b[A-Z]{1,3}-\d+\b/g;
const FOLDERS = ["docs", "content", "data/catalog"];

export function opaqueIds(text: string): string[] {
  return (text.match(OPAQUE) ?? []).filter((id) => !ALLOWED.has(id));
}

export function unitProblems(units: Loaded[]): string[] {
  const found: string[] = [];
  const opening = new Map<string, string>();
  for (const { unit, content } of units) {
    const earlier = opening.get(content.opening);
    if (earlier !== undefined)
      found.push(`D1 ${unit.slug} opens like ${earlier}: "${content.opening}"`);
    opening.set(content.opening, unit.slug);
    if (content.production.trim() === "") found.push(`D3 ${unit.slug}: no production line`);
  }
  return found;
}

function filesUnder(folder: string): string[] {
  const found: string[] = [];
  const base = join(ROOT, folder);
  for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(md|ts|json)$/.test(entry.name))
      found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

function idProblems(): string[] {
  const found: string[] = [];
  for (const folder of FOLDERS) {
    let files: string[] = [];
    try {
      files = filesUnder(folder);
    } catch {
      continue; // a folder that does not exist yet has no ids
    }
    for (const file of files) {
      for (const id of opaqueIds(readFileSync(file, "utf8")))
        found.push(`D2 ${file}: opaque id ${id}`);
    }
  }
  return found;
}

if (import.meta.main) {
  const problems = [...unitProblems(await builtUnits()), ...idProblems()];
  finish(
    problems,
    "Every unit opens on its own question, and every id is a readable name.",
    "distinct problems.",
  );
}
