import { getDocumentProxy } from "unpdf";

// Lesson 20. A company sends its labels as PDFs, not as Markdown. A label PDF is tagged (PDF/UA,
// the accessible PDF a screen reader needs): every heading, paragraph, list item and table cell is
// marked, in the order it was written. PDF.js (through unpdf, in this process) reads those tags.
// The positions on the page would not do: the leaflet has two columns, and a table cell that wraps
// to two lines ("Study / acronym") sits between the lines of the cell beside it, so a reader that
// sorts by position scrambles the dosing table. This file turns the tags into Markdown, cuts it
// into one chunk per label section, and checks that no word of the source text was lost.

export type ExtractedSection = { section: string; title: string; text: string };

// Only "## 2.2 Title", "## 4.2.1 Title" or "## 10 Title" starts a section: that number is what a citation names.
// Any other heading ("CONTRAINDICATIONS:") stays inside the section it belongs to.
const SECTION = /^##\s+(\d+(?:\.\d+)*)\s+(.+?)\s*$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };

function cleanLine(line: string): string {
  return (
    line
      .replace(/&(lt|gt|amp|quot|#39);/g, (entity) => ENTITIES[entity])
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


// --- Reading a tagged PDF. PDF.js gives each page's tag tree, whose leaves name marked runs of
//     text, and the page's text with those marks in it. The tree is walked in order and each tag
//     written as Markdown: a heading as "## ", a list item as "- ", a table row by row.
type TagContent = { type: "content"; id: string };
type TagNode = { role: string; children?: Array<TagNode | TagContent | { type: string }> };
type TextPart = { str?: string; hasEOL?: boolean; type?: string; id?: string };

const HEADINGS = new Set(["H", "H1", "H2", "H3", "H4", "H5", "H6", "Title"]);
// Tags that hold one block of text. Every other tag only groups blocks.
const TEXT = new Set(["P", "Caption", "Note", "BlockQuote", "Code"]);
const SKIPPED = new Set(["Artifact", "Figure"]);
const MARKER = /^\s*(?:[•◦▪‣·–-]|\d+[.)]|[a-z][.)])\s*$/i;

// The marked runs of one page. A run can sit inside another (a link inside its paragraph): the
// outer run then holds the inner one in place, and the inner one is written there, once.
class Runs {
  private pieces = new Map<string, Array<string | { run: string }>>();
  private written = new Set<string>();

  constructor(parts: TextPart[]) {
    const open: Array<string | undefined> = [];
    const add = (piece: string | { run: string }) => {
      const id = [...open].reverse().find((mark) => mark !== undefined);
      if (id) this.pieces.set(id, [...(this.pieces.get(id) ?? []), piece]);
    };
    for (const part of parts) {
      if (part.type === "beginMarkedContentProps" || part.type === "beginMarkedContent") {
        if (part.id) add({ run: part.id });
        open.push(part.id);
      } else if (part.type === "endMarkedContent") open.pop();
      // A line break is a space, except after a hyphen or a dash: "Co-" then "administration" on
      // the next line is one word, as the label wrote it.
      else if (part.str !== undefined) add(part.str + (part.hasEOL && !/[-–]$/.test(part.str) ? " " : ""));
    }
  }

  // The run's text with the runs inside it, or "" when it was already written inside another.
  text(id: string): string {
    if (this.written.has(id)) return "";
    this.written.add(id);
    return (this.pieces.get(id) ?? []).map((piece) => (typeof piece === "string" ? piece : this.text(piece.run))).join("");
  }
}

function runsOf(node: TagNode, marks: Runs): string[] {
  return (node.children ?? []).flatMap((child) =>
    "role" in child ? runsOf(child as TagNode, marks) : child.type === "content" ? [marks.text((child as TagContent).id)] : []
  );
}

const textOf = (node: TagNode, marks: Runs) => runsOf(node, marks).join("").replace(/\s+/g, " ").trim();

function blocksOf(node: TagNode, marks: Runs, out: string[]) {
  if (SKIPPED.has(node.role)) return;
  if (HEADINGS.has(node.role)) out.push(`## ${textOf(node, marks)}`);
  else if (TEXT.has(node.role)) out.push(textOf(node, marks));
  else if (node.role === "LI") {
    // The list marker ("1." or a bullet) is painted after the item's text, so its run comes last
    // inside the item. A run that is only a marker is taken out and written first.
    const runs = runsOf(node, marks);
    const marker = runs.findIndex((run) => MARKER.test(run));
    const label = marker < 0 ? "-" : runs.splice(marker, 1)[0]!.trim();
    out.push(`${/^\d/.test(label) ? label : "-"} ${runs.join("").replace(/\s+/g, " ").trim()}`);
  } else if (node.role === "Table") {
    const rows: string[][] = [];
    const walkRows = (group: TagNode) => {
      for (const child of group.children ?? []) {
        if (!("role" in child)) continue;
        const kid = child as TagNode;
        if (kid.role === "TR") rows.push((kid.children ?? []).filter((cell): cell is TagNode => "role" in cell).map((cell) => textOf(cell, marks).replace(/\|/g, "/")));
        else walkRows(kid);
      }
    };
    walkRows(node);
    if (!rows.length) return;
    const line = (row: string[]) => `| ${row.join(" | ")} |`;
    // A table that runs onto the next page starts there with its header again. Its rows belong to
    // the table already written, and the repeated header is dropped.
    const last = out.at(-1);
    if (last?.startsWith(`${line(rows[0]!)}\n`)) out[out.length - 1] = [last, ...rows.slice(1).map(line)].join("\n");
    else out.push([line(rows[0]!), `|${" --- |".repeat(rows[0]!.length)}`, ...rows.slice(1).map(line)].join("\n"));
  } else for (const child of node.children ?? []) if ("role" in child) blocksOf(child as TagNode, marks, out);
}

export async function pdfToMarkdown(bytes: Uint8Array, name = "the PDF"): Promise<string> {
  // PDF.js takes the buffer over, so it gets a copy: the caller still hashes the bytes.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const blocks: string[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const tree = (await page.getStructTree()) as TagNode | null;
      // An untagged PDF has only positions, and reading a two-column label from positions loses
      // its tables. It is refused, and the company is asked for the tagged (PDF/UA) file.
      if (!tree) throw new Error(`${name} is not a tagged PDF (page ${pageNo} has no tags). Ask for the PDF/UA version of the label.`);
      const content = await page.getTextContent({ includeMarkedContent: true });
      blocksOf(tree, new Runs(content.items as TextPart[]), blocks);
    }
    return blocks.filter((block) => block.replace(/^(## |- )/, "").trim()).join("\n\n");
  } finally {
    // Frees the parsed pages and the worker the reader started.
    await pdf.loadingTask.destroy();
  }
}
