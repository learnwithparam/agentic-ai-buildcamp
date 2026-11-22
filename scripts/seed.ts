// bun run seed: builds every file the course reads from the catalog, with a fixed seed.
// Two runs give the same bytes. Output goes to .data/ (documents, sql, competitors).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { COMMERCIAL_DISPENSES, TERRITORY_RX_WEEKLY } from "../data/catalog/analytics";
import { GLYPH_WIDTH, glyphRows } from "../data/catalog/block-font";
import { DOCUMENTS, type HcpDocument } from "../data/catalog/documents";
import {
  COMPETITORS,
  type Competitor,
  PRODUCT_FUNNEL,
  WORKSPACES,
} from "../data/catalog/mission-control";
import { GRANTS, PEOPLE } from "../data/catalog/people";
import { PRESCRIBERS } from "../data/catalog/prescribers";
import { ROOT } from "./root";

export const OUTPUT = join(ROOT, ".data");
const FIXED_DATE = new Date("2026-11-20T00:00:00Z");

type Page = ReturnType<PDFDocument["addPage"]>;
type Row = Record<string, string | number>;

function quote(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

function insertAll(table: string, rows: Row[]): string {
  const lines = rows.map((row) => {
    const values = Object.values(row).map(quote);
    return `(${values.join(", ")})`;
  });
  const columns = Object.keys(rows[0]).join(", ");
  return `INSERT INTO ${table} (${columns}) VALUES\n${lines.join(",\n")};\n`;
}

// A scan has no text layer. The words are drawn as blocks, so only a page reader can find them.
const BLOCK = 5;
const LETTER_ADVANCE = (GLYPH_WIDTH + 1) * BLOCK;
const MOST_LETTERS_ACROSS = 17;
const LINE_HEIGHT = 60;

function inkBlock(page: Page, left: number, top: number): void {
  page.drawRectangle({
    x: left,
    y: top,
    width: BLOCK + 0.6,
    height: BLOCK + 0.6,
    color: rgb(0, 0, 0),
  });
}

function drawLetter(page: Page, character: string, left: number, top: number): void {
  glyphRows(character).forEach((row, down) => {
    [...row].forEach((cell, across) => {
      if (cell === "#") inkBlock(page, left + across * BLOCK, top - down * BLOCK);
    });
  });
}

function drawScan(page: Page, text: string): void {
  const lines = wrapWords(text, MOST_LETTERS_ACROSS);
  lines.forEach((line, row) => {
    [...line].forEach((character, column) => {
      drawLetter(page, character, 50 + column * LETTER_ADVANCE, 700 - row * LINE_HEIGHT);
    });
  });
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length > width) lines.push(line);
    line = next.length > width ? word : next;
  }
  return [...lines, line];
}

async function drawText(pdf: PDFDocument, page: Page, document: HcpDocument): Promise<void> {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(document.title, { x: 50, y: 740, size: 14, font });
  const columns = document.type === "two-column" ? 2 : 1;
  document.body.split(". ").forEach((sentence, index) => {
    const across = 50 + (index % columns) * 260;
    const down = 700 - Math.floor(index / columns) * 20;
    page.drawText(sentence, { x: across, y: down, size: 10, font, maxWidth: 240 });
  });
  const note = `Version ${document.version}, from ${document.effective}. Invented for training.`;
  page.drawText(note, { x: 50, y: 60, size: 8, font });
}

async function writeDocument(document: HcpDocument): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const page = pdf.addPage([612, 792]);
  if (document.type === "scanned-page") drawScan(page, document.body);
  else await drawText(pdf, page, document);
  writeFileSync(join(OUTPUT, "documents", `${document.slug}.pdf`), await pdf.save());
}

const SCHEMAS = ["pharma_a", "pharma_b", "analytics"];

const TABLES: Record<string, string> = {
  "pharma_a.territory_rx_weekly":
    "territory text, brand text, week_start date, new_prescriptions int, total_prescriptions int",
  "pharma_b.commercial_dispenses":
    "region text, product text, month text, units_dispensed int, net_sales_usd int",
  "analytics.product_funnel": "week_start date, plan text, signups int, activated int, churned int",
  prescribers: "name text, npi text, email text, specialty text, territory text",
  people: "name text, display_name text, tenant text, role text, country text, clearance int",
  grants: "person text, relation text, object text",
};

function schemaSql(): string {
  const schemas = SCHEMAS.map((name) => `CREATE SCHEMA IF NOT EXISTS ${name};`);
  const tables = Object.entries(TABLES).map(([name, columns]) => {
    return `CREATE TABLE ${name} (${columns});`;
  });
  return [...schemas, ...tables].join("\n");
}

function peopleRows(): Row[] {
  return PEOPLE.map((person) => ({
    name: person.name,
    display_name: person.displayName,
    tenant: person.tenant,
    role: person.role,
    country: person.country,
    clearance: person.clearance,
  }));
}

function writeSql(): void {
  const inserts = [
    insertAll("pharma_a.territory_rx_weekly", TERRITORY_RX_WEEKLY),
    insertAll("pharma_b.commercial_dispenses", COMMERCIAL_DISPENSES),
    insertAll("analytics.product_funnel", PRODUCT_FUNNEL),
    insertAll("prescribers", PRESCRIBERS),
    insertAll("people", peopleRows()),
    insertAll("grants", GRANTS),
  ];
  writeFileSync(join(OUTPUT, "sql", "seed.sql"), `${schemaSql()}\n\n${inserts.join("\n")}`);
}

const BANNER = '<div id="cookie-banner">We use cookies. Accept all or choose.</div>';
const NOISE = "<style>body { font-family: sans-serif; }</style><script>track('view');</script>";

function rivalPage(rival: Competitor, when: "before" | "after"): string {
  const hidden = rival.hidden === undefined ? "" : `<section hidden>${rival.hidden}</section>`;
  const body = `<h1>${rival.name}</h1><p>${rival[when]}</p>${hidden}`;
  return `<html><head>${NOISE}</head><body>${BANNER}${body}</body></html>\n`;
}

function writeCompetitors(): void {
  for (const rival of COMPETITORS) {
    for (const when of ["before", "after"] as const) {
      const page = rivalPage(rival, when);
      const name = `${rival.name.toLowerCase()}-${when}.html`;
      writeFileSync(join(OUTPUT, "competitors", name), page);
    }
  }
}

function writeMemos(): void {
  for (const workspace of WORKSPACES) {
    if (workspace.memo === undefined) continue;
    writeFileSync(join(OUTPUT, "workspaces", `${workspace.name}-memo.txt`), `${workspace.memo}\n`);
  }
}

export async function seed(): Promise<void> {
  for (const folder of ["documents", "sql", "competitors", "workspaces"]) {
    mkdirSync(join(OUTPUT, folder), { recursive: true });
  }
  for (const document of DOCUMENTS) await writeDocument(document);
  writeSql();
  writeCompetitors();
  writeMemos();
}

if (import.meta.main) {
  await seed();
  console.log(`Seeded ${DOCUMENTS.length} documents and the data files into ${OUTPUT}.`);
}
