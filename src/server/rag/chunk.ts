// How the label library is cut for search. A section is what a doctor cites, so it stays the unit
// every result names. A long section is split into passages, so one paragraph about potassium is
// not drowned in 600 words about something else. A table is never split: a row without its header
// is a number without a meaning.

// Raise it when the rules below change: ingest then re-cuts every PDF, changed or not.
export const CHUNKER = "passages-v1";

// Measured on the dataset's 653 sections: the median is 100 words and 9 run past 400.
export const MAX_PASSAGE_WORDS = 300;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

// Blocks are paragraphs and lists separated by a blank line; a run of table lines is one block
// even where the table has no blank line around it.
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inTable = false;
  const flush = () => {
    if (current.length) out.push(current.join("\n").trim());
    current = [];
  };
  for (const line of text.split("\n")) {
    const isTable = line.trim().startsWith("|");
    if (isTable !== inTable && current.length) flush();
    inTable = isTable;
    if (!isTable && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return out.filter(Boolean);
}

// Whole blocks packed in order up to the limit. A block longer than the limit (a big table) is a
// passage on its own.
export function passages(text: string, maxWords = MAX_PASSAGE_WORDS): string[] {
  if (wordCount(text) <= maxWords) return [text];
  const parts: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const block of blocks(text)) {
    const size = wordCount(block);
    if (current.length && words + size > maxWords) {
      parts.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(block);
    words += size;
  }
  if (current.length) parts.push(current.join("\n\n"));
  return parts;
}

// "5 Warnings and Precautions > 5.3 Hyperkalemia" when the document has a "5" section, else
// "5.3 Hyperkalemia".
export function sectionPath(section: { section: string; title: string }, all: Array<{ section: string; title: string }>): string {
  const top = section.section.split(".")[0];
  const parent = top !== section.section ? all.find((each) => each.section === top) : undefined;
  const own = `${section.section} ${section.title}`;
  return parent ? `${parent.section} ${parent.title} > ${own}` : own;
}
