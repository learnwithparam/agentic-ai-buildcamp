// Every new word is defined once, in docs/walkthrough.md under "### Concepts", and each lesson
// links the 2 to 5 words it teaches. A definition is written as
//   <a id="c-citation-check"></a>
//   **Citation check.** What it is. Why it matters.
// Rules, with the number in each message (the same as live-labs scripts/glossary.ts):
//   G1  every concept a lesson links exists in the walkthrough
//   G2  every concept in the walkthrough is linked by at least one lesson
//   G3  one word, one meaning: no word is defined twice
//   G4  a meaning is at most 2 sentences of 18 words or fewer, at grade 6 or below
//   G5  a lesson links 2 to 5 different words
//   G6  each word a lesson links appears in its own text, not only in the list or a diagram
import { readFileSync } from "node:fs";
import { lessonFiles, sectionOf } from "./lesson-shape";
import { WALKTHROUGH } from "./mermaid";
import { readingGrade, sentencesOf, withoutFrontMatter } from "./plain-english";

const MOST_WORDS_IN_SENTENCE = 18;
const MOST_SENTENCES = 2;
const GRADE_LIMIT = 6;
const FEWEST_WORDS = 2;
const MOST_WORDS = 5;

export type Concept = { id: string; word: string; meaning: string };

export function conceptsOf(walkthrough: string): Concept[] {
  const section = sectionOf(withoutFrontMatter(walkthrough), "### Concepts");
  return [...section.matchAll(/<a id="(c-[a-z0-9-]+)"><\/a>\s*\n\*\*([^*]+?)\.\*\*\s*([^\n]+)/g)].map((match) => ({
    id: match[1],
    word: match[2].trim(),
    meaning: match[3].trim()
  }));
}

export function meaningProblems(concept: Concept): string[] {
  const found: string[] = [];
  const sentences = sentencesOf(concept.meaning);
  if (sentences.length > MOST_SENTENCES) found.push(`G4 "${concept.word}": ${sentences.length} sentences; keep to ${MOST_SENTENCES}`);
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).length;
    if (count > MOST_WORDS_IN_SENTENCE) found.push(`G4 "${concept.word}": ${count}-word sentence; keep to ${MOST_WORDS_IN_SENTENCE}`);
  }
  const grade = readingGrade(sentences);
  if (sentences.length && grade > GRADE_LIMIT) found.push(`G4 "${concept.word}": grade ${grade.toFixed(1)}; keep to ${GRADE_LIMIT}`);
  if (/[;—]/.test(concept.meaning)) found.push(`G4 "${concept.word}": no semicolons or em dashes`);
  return found;
}

// The anchors a lesson's "### Concepts" links: ../walkthrough.md#c-...
export function linkedConcepts(page: string): string[] {
  return [...sectionOf(withoutFrontMatter(page), "### Concepts").matchAll(/walkthrough\.md#(c-[a-z0-9-]+)\)/g)].map((match) => match[1]);
}

// The lesson's own words: no Concepts list, no diagrams, no code.
export function lessonText(page: string): string {
  const markdown = withoutFrontMatter(page);
  const concepts = sectionOf(markdown, "### Concepts");
  return markdown.replace(concepts, "").replace(/```[\s\S]*?```/g, "").toLowerCase();
}

export function glossaryProblems(walkthrough: string, lessons: Array<{ file: string; page: string }>): string[] {
  const found: string[] = [];
  const concepts = conceptsOf(walkthrough);
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const seen = new Map<string, string>();
  for (const concept of concepts) {
    const key = concept.word.toLowerCase();
    if (seen.has(key)) found.push(`G3 "${concept.word}" is defined twice: ${seen.get(key)} and ${concept.id}`);
    seen.set(key, concept.id);
    found.push(...meaningProblems(concept));
  }
  const used = new Set<string>();
  for (const { file, page } of lessons) {
    const ids = linkedConcepts(page);
    if (ids.length < FEWEST_WORDS || ids.length > MOST_WORDS) found.push(`G5 ${file}: links ${ids.length} words; keep to ${FEWEST_WORDS} to ${MOST_WORDS}`);
    if (new Set(ids).size !== ids.length) found.push(`G5 ${file}: links a word twice`);
    const text = lessonText(page);
    for (const id of ids) {
      used.add(id);
      const concept = byId.get(id);
      if (!concept) {
        found.push(`G1 ${file}: "${id}" is not defined in ${WALKTHROUGH}`);
        continue;
      }
      if (!text.includes(concept.word.toLowerCase())) found.push(`G6 ${file}: "${concept.word}" is linked but never used in the lesson text`);
    }
  }
  for (const concept of concepts) if (!used.has(concept.id)) found.push(`G2 "${concept.word}" is defined in ${WALKTHROUGH} but no lesson links it`);
  return found;
}

if (import.meta.main) {
  const walkthrough = readFileSync(WALKTHROUGH, "utf8");
  const problems = glossaryProblems(walkthrough, lessonFiles().map((file) => ({ file, page: readFileSync(file, "utf8") })));
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} glossary problems.`);
    process.exit(1);
  }
  console.log(`Every new word is defined once, in plain words, and used in its lesson (${conceptsOf(walkthrough).length} words).`);
}
