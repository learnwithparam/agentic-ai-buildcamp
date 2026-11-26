// bun run plain-english: every page reads easily for a beginner
// whose first language is not English.
//
// Short sentences, everyday words, and an example on every teaching page.
// Code blocks, tables and headings are skipped: they are not sentences.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
const ROOT = process.cwd();

// The same limits as the live-labs repo, so the two do not drift. They live here, not in
// package.json, because a checkpoint tag keeps its own package.json.
const READING_GRADE = 6;
const LONGEST_SENTENCE = 18;
const AVERAGE_SENTENCE = 12;

const SKIPPED_FOLDERS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "recordings",
  "research",
  "fixtures",
  // The two case study briefs keep their authored wording as problem statements.
  "case-studies",
]);

// Pages for the people who build the course, not for learners.
const AUTHOR_PAGES = new Set(["STANDARD.md", "SPEC.md", "PARTS.md"]);

// Words that make a reader reach for a dictionary, and the everyday word to use instead.
const SIMPLER_WORDS: Record<string, string> = {
  utilize: "use",
  utilise: "use",
  facilitate: "help",
  commence: "start",
  terminate: "end or stop",
  subsequently: "then",
  approximately: "about",
  sufficient: "enough",
  "prior to": "before",
  "in order to": "to",
  numerous: "many",
  obtain: "get",
  endeavor: "try",
  ascertain: "find out",
  thereby: "so",
  hence: "so",
  thus: "so",
  whereas: "while",
  "e.g.": "for example",
  "i.e.": "that is",
  "etc.": "the full list",
  via: "through or with",
  paradigm: "way of working",
  robust: "strong, or say what it survives",
  "in terms of": "a plainer phrase",
  "it is worth noting": "nothing; just say it",
  basically: "nothing; cut it",
  simply: "nothing; cut it",
  obviously: "nothing; cut it",
  "just ": "nothing; cut it",
};

type Problem = { file: string; message: string };

function markdownFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    if (SKIPPED_FOLDERS.has(entry)) continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, found);
    else if (path.endsWith(".md") && !AUTHOR_PAGES.has(entry)) found.push(path);
  }
  return found;
}

// The fence that a line opens or closes a code block with, or "" for any other line.
function fenceOn(line: string): string {
  return line.trim().match(/^`{3,}/)?.[0] ?? "";
}

// Which fence is open after this line: "" outside a code block.
// A block closes only on a fence at least as long as the one that opened it,
// so a ```yaml block quoted inside a ````text block stays inside.
function openFenceAfter(line: string, openFence: string): string {
  const fence = fenceOn(line);
  if (openFence === "") return fence;
  if (fence.length >= openFence.length) return "";
  return openFence;
}

const COMMAND_WORDS = new Set([
  "bun",
  "bunx",
  "git",
  "claude",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "uv",
  "make",
  "pip",
  "python",
  "node",
  "fail",
  "pass",
  "error",
  "docker",
  "gh",
  "cd",
  "ls",
  "cat",
  "curl",
  "echo",
  "export",
  "cp",
  "mv",
  "mkdir",
  "rm",
]);
const MOST_WORDS_IN_CODE = 2;

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// A span of 3 or more words with no command, path, flag, URL, file name or code in it is English.
function isBacktickedEnglish(inside: string): boolean {
  if (wordCount(inside) <= MOST_WORDS_IN_CODE) return false;
  if (/[/.(=$]|--/.test(inside) || inside.trim().startsWith("-")) return false;
  // "bun: command not found" and "FAIL ..." are output the learner sees, not English to rewrite.
  const [firstWord] = inside.trim().split(/\s+/);
  const commandName = firstWord.toLowerCase().replace(/:$/, "");
  return !COMMAND_WORDS.has(commandName);
}

// Every line outside a code fence, headings included, with command spans taken out.
function textOutsideCode(markdown: string): string {
  const kept: string[] = [];
  let openFence = "";
  for (const line of markdown.split("\n")) {
    const isFence = fenceOn(line) !== "";
    openFence = openFenceAfter(line, openFence);
    if (!isFence && openFence === "") kept.push(line);
  }
  const noCommands = kept.join("\n").replace(/`([^`\n]*)`/g, (span, inside) => {
    return isBacktickedEnglish(inside) ? span : "";
  });
  return noCommands.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function backtickProblems(file: string, markdown: string): Problem[] {
  const spans = textOutsideCode(markdown).match(/`[^`\n]*`/g) ?? [];
  const message = "backticked English: say it in plain words, keep backticks for what you type";
  return spans.map((span) => ({ file, message: `${message} (${span})` }));
}

// Exact times go stale and make a learner feel slow. A rough word costs nothing.
const MINUTES = /\b\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:minutes?|mins?)\b/gi;

function minutesProblems(file: string, markdown: string): Problem[] {
  const found = textOutsideCode(markdown).match(MINUTES) ?? [];
  const advice = "use a rough word like an evening";
  return found.map((text) => ({ file, message: `exact minutes "${text}": ${advice}` }));
}

// Lockfiles already pin versions. A page that repeats one goes out of date.
const TOOLS = "Bun|Node|Node\\.js|Python|Go|Java|Rust|Deno|npm|React|TypeScript|Docker|Claude|Git";
const VERSIONS = [
  /\bv\d+(?:\.\d+)*\b/g,
  /(?<![\d.-])(?!\d{4}\.)\d{1,3}\.\d+\.\d+(?![\d.]*\d{4})\b/g,
  new RegExp(`\\b(?:${TOOLS})\\s+v?\\d+(?:\\.\\d+)*\\b(?![/%])`, "g"),
  /\b[A-Z][A-Za-z]+\s+\d+\.\d+(?:\.\d+)*\b(?!%)/g,
];

function versionProblems(file: string, markdown: string): Problem[] {
  const text = textOutsideCode(markdown);
  const all = [...new Set(VERSIONS.flatMap((pattern) => text.match(pattern) ?? []))];
  // "Bun 1.3.2" also contains "1.3.2"; report the version once.
  const found = all.filter((one) => !all.some((other) => other !== one && other.includes(one)));
  const advice = 'say "install Bun", not the number';
  return found.map((text) => ({ file, message: `version number "${text}": ${advice}` }));
}

// A date makes a page feel old. Say what a thing is, not when it appeared.
const YEAR = "(?:20(?:1[5-9]|2\\d|3\\d))";
const MONTH = [
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?",
  "Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)",
].join("|");
const DATES = [
  new RegExp(`(?<![\\d./-])${YEAR}(?![\\d]|[./-]\\d)`, "g"),
  new RegExp(`\\b${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\b|${YEAR}\\b)`, "g"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "g"),
  /\bas of\s+(?:\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b)/gi,
  /\blast updated\b/gi,
  /\bupdated on\b/gi,
  /\bnew in\s+\d{4}\b/gi,
  /\breleased in\b/gi,
];

function dateProblems(file: string, markdown: string): Problem[] {
  const text = textOutsideCode(markdown);
  const found = text.split("\n").flatMap((line) => {
    const hits = DATES.flatMap((pattern) => line.match(pattern) ?? []);
    return hits.length === 0 ? [] : [line];
  });
  return found.map((line) => ({
    file,
    message: `date in prose: say what it is, not when (${line.trim().slice(0, 40)})`,
  }));
}

// Keep only the lines a person reads as sentences.
export function proseOf(markdown: string): string {
  const proseLines: string[] = [];
  let openFence = "";
  for (const line of markdown.split("\n")) {
    const isFence = fenceOn(line) !== "";
    openFence = openFenceAfter(line, openFence);
    const isStructure = /^\s*(#|\||<|!\[|Expect:)/.test(line);
    if (!isFence && openFence === "" && !isStructure) proseLines.push(line);
  }
  // Inline code stays on one line, so a stray backtick cannot hide the paragraphs after it.
  // Code becomes "it". English inside a span stays, so it counts toward the grade.
  const withoutInlineCode = proseLines
    .join("\n")
    .replace(/`([^`\n]*)`/g, (_span, inside) =>
      isBacktickedEnglish(inside) || wordCount(inside) === 2 ? inside : "it",
    );
  return withoutInlineCode.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

export function sentencesOf(prose: string): string[] {
  const paragraphs = prose.split(/\n\s*\n|\n\s*[-*\d]+[.)]?\s/);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.split(/(?<=[.!?:])\s+/));
  const tidied = sentences.map((sentence) => sentence.replace(/\s+/g, " ").trim());
  return tidied.filter(Boolean);
}

const wordsOf = (sentence: string) => sentence.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];

export function syllablesIn(word: string): number {
  const lower = word.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  const vowelGroups = lower.match(/[aeiouy]{1,2}/g);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

// The average number of words in a sentence.
export function averageWords(sentences: string[]): number {
  if (sentences.length === 0) return 0;
  return sentences.flatMap(wordsOf).length / sentences.length;
}

// Flesch-Kincaid grade level: about the school year a reader needs to follow the text.
export function readingGrade(sentences: string[]): number {
  const words = sentences.flatMap(wordsOf);
  if (sentences.length === 0 || words.length === 0) return 0;
  const syllables = words.reduce((total, word) => total + syllablesIn(word), 0);
  const wordsPerSentence = words.length / sentences.length;
  const syllablesPerWord = syllables / words.length;
  return 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
}

function isTeachingPage(file: string): boolean {
  const path = relative(ROOT, file);
  const isStepReadme = /problem\/README\.md$/.test(path);
  const isPartReadme = /^parts\/[^/]+\/README\.md$/.test(path);
  return isStepReadme || isPartReadme || path === "README.md";
}

function hardWordProblems(file: string, prose: string): Problem[] {
  const problems: Problem[] = [];
  const lowerProse = ` ${prose.toLowerCase()} `;
  for (const [hardWord, simpler] of Object.entries(SIMPLER_WORDS)) {
    const escaped = hardWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`[^a-z]${escaped}(?![a-z])`);
    if (pattern.test(lowerProse)) {
      problems.push({ file, message: `"${hardWord.trim()}": write ${simpler}` });
    }
  }
  return problems;
}

function sentenceProblems(file: string, sentences: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const sentence of sentences) {
    const count = wordsOf(sentence).length;
    if (count > LONGEST_SENTENCE) {
      const opening = sentence.split(" ").slice(0, 8).join(" ");
      problems.push({ file, message: `${count}-word sentence "${opening}..."; split it` });
    }
  }
  return problems;
}

// The YAML front matter is for the site, not the reader.
export const withoutFrontMatter = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
// A from-comment (scripts/page-numbers.ts) is a pointer for a check, not words for a reader.
const withoutComments = (markdown: string) => markdown.replace(/ ?<!--[\s\S]*?-->/g, "");

export function problemsIn(file: string, page: string, gradeLimit: number): Problem[] {
  const markdown = withoutComments(withoutFrontMatter(page));
  const prose = proseOf(markdown);
  const sentences = sentencesOf(prose);
  const problems = [
    ...hardWordProblems(file, prose),
    ...sentenceProblems(file, sentences),
    ...backtickProblems(file, markdown),
    ...minutesProblems(file, markdown),
  ];

  const average = averageWords(sentences);
  const averageLimit = AVERAGE_SENTENCE;
  if (sentences.length >= 5 && average > averageLimit) {
    const message = `sentences average ${average.toFixed(1)} words, above ${averageLimit}; cut them shorter`;
    problems.push({ file, message });
  }
  const grade = readingGrade(sentences);
  if (sentences.length >= 5 && grade > gradeLimit) {
    const shown = grade.toFixed(1);
    const message = `reading grade ${shown}, above ${gradeLimit}; use shorter words`;
    problems.push({ file, message });
  }
  if (isTeachingPage(file) && !/\bfor example\b/i.test(markdown)) {
    problems.push({ file, message: 'no "For example": show one real case, not only the rule' });
  }
  return problems;
}

// The teach rules for learner pages (teach repo: scripts/learner-clarity.mjs and strict-grade.mjs).
// They are stricter than the rules above. Five sentences at most in a paragraph. No semicolons or
// em dashes in prose. The grade also counts table cells, headings, list items and diagram labels,
// because a learner reads those too.
export const PARAGRAPH_SENTENCES = 5;

// The text a learner reads, with table cells, headings, list items and diagram labels included.
export function strictTextOf(markdown: string): string {
  const out: string[] = [];
  let openFence = "";
  let mermaid = false;
  for (const line of markdown.split("\n")) {
    const fence = fenceOn(line);
    if (fence !== "" || openFence !== "") {
      if (fence !== "") {
        mermaid = openFence === "" && /mermaid/.test(line);
        if (openFence === "") openFence = fence;
        else if (fence.length >= openFence.length) openFence = "";
        continue;
      }
      if (mermaid) {
        // Node labels sit in [] {} or "", and edge labels in ||.
        for (const match of line.matchAll(/"([^"]+)"|\[([^\]]+)\]|\|([^|]+)\||\{([^}]+)\}/g)) {
          out.push((match[1] || match[2] || match[3] || match[4]).replace(/[()]/g, ""));
        }
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      for (const cell of line.split("|").slice(1, -1)) out.push(cell.trim());
      continue;
    }
    out.push(line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+[.)]\s+/, ""));
  }
  return out
    .filter(Boolean)
    .map((line) => line.replace(/`[^`]*`/g, "it").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*/g, ""))
    .join("\n");
}

// Only real sentences are graded. A table cell or a diagram label of fewer than 8 words is a fragment,
// and a short fragment makes every grade look low. So the grade counts the cells that are sentences.
export const SENTENCE_CELL_WORDS = 8;

export function sentenceLinesOf(markdown: string): string[] {
  return strictTextOf(markdown)
    .split("\n")
    .filter((line) => line.trim().split(/\s+/).length >= SENTENCE_CELL_WORDS);
}

export function strictGradeOf(markdown: string): number {
  const sentences = sentenceLinesOf(markdown).flatMap((line) => line.split(/(?<=[.!?])\s+/));
  return readingGrade(sentences);
}

// Paragraphs: a blank line, a heading or a table row ends one. A list item or a bold label starts one.
export function paragraphsOfPage(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(" "));
    current = [];
  };
  let openFence = "";
  for (const line of markdown.split("\n")) {
    const fence = fenceOn(line);
    openFence = openFenceAfter(line, openFence);
    if (fence !== "" || openFence !== "") {
      flush();
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || /^(#|\|)/.test(trimmed)) {
      flush();
    } else if (/^([-*]\s|\d+[.)]\s|\*\*[^*]+:\*\*)/.test(trimmed)) {
      flush();
      current.push(trimmed);
    } else {
      current.push(trimmed);
    }
  }
  flush();
  return blocks;
}

export function teachProblems(file: string, page: string, gradeLimit: number): Problem[] {
  const markdown = withoutComments(withoutFrontMatter(page));
  const problems: Problem[] = [];
  for (const paragraph of paragraphsOfPage(markdown)) {
    const count = sentencesOf(paragraph.replace(/`[^`]*`/g, "it")).length;
    if (count > PARAGRAPH_SENTENCES) {
      problems.push({ file, message: `paragraph of ${count} sentences; keep it to ${PARAGRAPH_SENTENCES}: "${paragraph.slice(0, 50)}..."` });
    }
  }
  const prose = textOutsideCode(markdown);
  if (/;\s/.test(prose)) problems.push({ file, message: "semicolon in prose: use a full stop or a comma" });
  if (/\u2014/.test(markdown)) problems.push({ file, message: "em dash: use a full stop or a comma" });
  for (const line of strictTextOf(markdown).split("\n")) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const count = sentence.split(/\s+/).length;
      if (count > LONGEST_SENTENCE) {
        problems.push({ file, message: `${count}-word cell or label "${sentence.slice(0, 40)}..."; split it` });
      }
    }
  }
  for (const problem of hardWordProblems(file, strictTextOf(markdown))) problems.push(problem);
  const grade = strictGradeOf(markdown);
  if (grade > gradeLimit) problems.push({ file, message: `grade ${grade.toFixed(1)} over the sentences in tables and labels, above ${gradeLimit}` });
  return problems;
}

// The check tests itself first: code quoted inside a longer fence is never read as prose.
function fencesAreSkipped(): boolean {
  const sample = ["Intro.", "````text", "```yaml", "quoted: inside", "```", "````", "Outro."];
  return !proseOf(sample.join("\n")).includes("quoted");
}

if (import.meta.main) {
  if (!fencesAreSkipped()) {
    console.error("plain-english.ts reads quoted code as prose. Fix proseOf first.");
    process.exit(1);
  }
  const gradeLimit = READING_GRADE;
  // Named files narrow the run (check:changed and the prose test). Author pages stay skipped.
  const named = process.argv.slice(2).map((file) => resolve(ROOT, file));
  const files =
    named.length > 0
      ? named.filter((file) => !AUTHOR_PAGES.has(basename(file)))
      : markdownFiles(ROOT);
  const readProblems = (file: string) => problemsIn(file, readFileSync(file, "utf8"), gradeLimit);
  const problemsInFile = readProblems;
  const problems = files.flatMap((file) => [...problemsInFile(file), ...teachProblems(file, readFileSync(file, "utf8"), gradeLimit)]);
  for (const problem of problems) {
    console.error(`${relative(ROOT, problem.file)}: ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(`${problems.length} plain-English problems. See STANDARD.md, "Plain English".`);
    process.exit(1);
  }
  const summary = "Every page reads plainly: short sentences, everyday words";
  console.log(`${summary}, grade ${gradeLimit} or below.`);
}
