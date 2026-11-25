// Lesson 20. A company sends its labels as PDFs, not as Markdown. Docling (docling-serve, in
// infra/docker-compose.yml under the "ingest" profile) reads a PDF's layout: the two columns, the
// headings and the dosing table with its footnote. A plain text dump of the same PDF scrambles
// that table row by row, and so does Docling's own Markdown export when a table sits beside a
// column of text. This file puts Docling's layout boxes in reading order, column by column, cuts
// the result into one chunk per label section, and checks that no word of the source text was lost.

export type ExtractedSection = { section: string; title: string; text: string };

// Only "## 2.2 Title" or "## 10 Title" starts a section: that number is what a citation names.
// Docling also makes a heading of any bold line ("CONTRAINDICATIONS:"), which stays inside the
// section it belongs to.
const SECTION = /^##\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };

function cleanLine(line: string): string {
  return (
    line
      .replace(/&(lt|gt|amp|quot|#39);/g, (entity) => ENTITIES[entity])
      // A bullet in the leaflet's typeface ends with its own marker, which Docling keeps.
      .replace(/\s+[·◦]\s*$/, "")
      .trimEnd()
  );
}

export function sectionsFromMarkdown(markdown: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  let current: { section: string; title: string; lines: string[] } | null = null;
  const close = () => current && sections.push({ section: current.section, title: current.title, text: current.lines.join("\n").trim() });
  for (const raw of markdown.split("\n")) {
    const line = cleanLine(raw);
    const numbered = line.match(SECTION);
    if (numbered) {
      close();
      current = { section: numbered[1], title: numbered[2], lines: [] };
      continue;
    }
    // Text before the first numbered section is the document's title and stamp, not label text.
    if (!current) continue;
    const heading = line.match(HEADING);
    current.lines.push(heading ? heading[1] : line);
  }
  close();
  return sections;
}

// Letters and digits only, lower case. A line break, a hyphen split across lines, a table border
// or a bullet marker changes the layout, never the words.
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

// Every section of the source text must come out of the PDF, with all of its words in order.
// Returns one sentence per problem; an empty list means the extraction is complete.
export function missingFromExtraction(source: Array<{ section: string; text: string }>, extracted: ExtractedSection[]): string[] {
  const problems: string[] = [];
  const found = new Map(extracted.map((section) => [section.section, words(section.text)]));
  for (const want of source) {
    const got = found.get(want.section);
    if (got === undefined) problems.push(`section ${want.section} is not in the PDF's text`);
    else if (!got.includes(words(want.text))) problems.push(`section ${want.section} lost words on the way out of the PDF`);
  }
  const known = new Set(source.map((section) => section.section));
  for (const section of extracted) if (!known.has(section.section)) problems.push(`section ${section.section} is in the PDF but not in the source`);
  return problems;
}

// --- Reading order. Docling reads two headings that sit side by side, one per column, as one
//     line: on the CLARION-HF summary it put the 3.1 table under 3.2, and missingFromExtraction
//     caught it. Every PDF backend Docling has does the same. Its JSON keeps each block's page and
//     box, so the order is rebuilt here the way a person reads a two-column leaflet: down the page
//     band by band, a band ending at a block that spans both columns, the left column of a band
//     before the right.
type Box = { l: number; t: number; r: number; b: number; coord_origin: string };
type Prov = { page_no: number; bbox: Box };
type Ref = { $ref: string };
type DoclingText = { self_ref: string; label: string; text: string; prov: Prov[] };
type DoclingTable = { self_ref: string; label: string; prov: Prov[]; data: { grid: Array<Array<{ text: string }>> } };
type DoclingGroup = { self_ref: string; children: Ref[] };
export type DoclingDocument = {
  body: { children: Ref[] };
  groups: DoclingGroup[];
  texts: DoclingText[];
  tables: DoclingTable[];
  pages: Record<string, { size: { width: number; height: number } }>;
};

type Block = { page: number; box: Box; markdown: string };
const SKIP = new Set(["page_header", "page_footer"]);

function render(item: DoclingText | DoclingTable): string {
  if ("data" in item) {
    const rows = item.data.grid.map((row) => `| ${row.map((cell) => cell.text.replace(/\|/g, "/")).join(" | ")} |`);
    return [rows[0], `|${" --- |".repeat(item.data.grid[0]?.length ?? 0)}`, ...rows.slice(1)].join("\n");
  }
  if (item.label === "section_header" || item.label === "title") return `## ${item.text}`;
  if (item.label === "list_item") return `- ${item.text}`;
  return item.text;
}

function blocksOf(doc: DoclingDocument): Block[] {
  const lookup = (ref: string) => {
    const [, kind, index] = ref.split("/");
    return (doc as unknown as Record<string, unknown[]>)[kind]?.[Number(index)] as DoclingText | DoclingTable | DoclingGroup | undefined;
  };
  const blocks: Block[] = [];
  const walk = (refs: Ref[]) => {
    for (const { $ref } of refs) {
      const item = lookup($ref);
      if (!item) continue;
      // Every node has children; a group (a list) is only the ones under #/groups.
      if ($ref.startsWith("#/groups/")) walk((item as DoclingGroup).children);
      else if ("prov" in item && !SKIP.has(item.label) && item.prov[0]) {
        const markdown = render(item);
        // A bullet marker Docling read as a list item of its own.
        if (markdown.replace(/^- /, "").trim().replace(/[·◦•]/g, "")) blocks.push({ page: item.prov[0].page_no, box: item.prov[0].bbox, markdown });
      }
    }
  };
  walk(doc.body.children);
  return blocks;
}

// Top of a box, larger is higher up the page, whichever corner Docling measured from.
const top = (box: Box, pageHeight: number) => (box.coord_origin === "BOTTOMLEFT" ? box.t : pageHeight - box.t);

export function readingOrder(doc: DoclingDocument): string {
  const blocks = blocksOf(doc);
  const ordered: Block[] = [];
  for (const page of [...new Set(blocks.map((block) => block.page))].sort((a, b) => a - b)) {
    const height = doc.pages[String(page)]?.size.height ?? 0;
    const onPage = blocks.filter((block) => block.page === page).sort((a, b) => top(b.box, height) - top(a.box, height));
    const left = Math.min(...onPage.map((block) => block.box.l));
    const right = Math.max(...onPage.map((block) => block.box.r));
    // A block starts the right column when its left edge is well in from the page's left edge.
    // The centre would not do: a wide title or table moves it, and an indented bullet is not a column.
    const secondColumn = left + 0.3 * (right - left);
    const spans = (block: Block) => block.box.r - block.box.l > 0.6 * (right - left);
    let band: Block[] = [];
    const flush = () => {
      const column = (block: Block) => (block.box.l < secondColumn ? 0 : 1);
      ordered.push(...band.sort((a, b) => column(a) - column(b) || top(b.box, height) - top(a.box, height)));
      band = [];
    };
    for (const block of onPage) {
      if (spans(block)) {
        flush();
        ordered.push(block);
      } else band.push(block);
    }
    flush();
  }
  return ordered.map((block) => block.markdown).join("\n\n");
}

// docling-serve's synchronous endpoint: one PDF in, the layout as JSON out. OCR stays off,
// because these PDFs carry their text; a scanned label would need it on.
export async function convertPdf(doclingUrl: string, file: { name: string; bytes: Uint8Array }): Promise<DoclingDocument> {
  const form = new FormData();
  form.append("files", new Blob([Buffer.from(file.bytes)], { type: "application/pdf" }), file.name);
  form.append("to_formats", "json");
  form.append("do_ocr", "false");
  const response = await fetch(`${doclingUrl}/v1/convert/file`, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Docling could not convert ${file.name} (${response.status}). Is it running? npm run rag:setup (lesson 20).`);
  const body = (await response.json()) as { status: string; document?: { json_content?: DoclingDocument } };
  const doc = body.document?.json_content;
  if (body.status !== "success" || !doc) throw new Error(`Docling returned ${body.status} for ${file.name}.`);
  return doc;
}
