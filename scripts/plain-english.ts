// bun run plain-english: every page reads easily for a beginner
// whose first language is not English.
//
// Short sentences, everyday words, and an example on every teaching page.
// Code blocks, tables and headings are skipped: they are not sentences.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./structure";

// A course for everyone (no code) can lower this in package.json: "plainEnglish": { "grade": 6 }.
const DEFAULT_READING_GRADE = 8;
const LONGEST_SENTENCE = 25;

const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".venv", "recordings", "research"]);

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
  const withoutInlineCode = proseLines.join("\n").replace(/`[^`\n]*`/g, "it");
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

export function problemsIn(file: string, markdown: string, gradeLimit: number): Problem[] {
  const prose = proseOf(markdown);
  const sentences = sentencesOf(prose);
  const problems = [...hardWordProblems(file, prose), ...sentenceProblems(file, sentences)];

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

function configuredGrade(): number {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const grade = packageJson.plainEnglish?.grade;
  return typeof grade === "number" ? grade : DEFAULT_READING_GRADE;
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
  const gradeLimit = configuredGrade();
  const files = markdownFiles(ROOT);
  const problemsInFile = (file: string) => problemsIn(file, readFileSync(file, "utf8"), gradeLimit);
  const problems = files.flatMap(problemsInFile);
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
