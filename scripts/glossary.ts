// bun run glossary: every new word is defined once, in plain words, and used on its page.
//
//   G1  every term has an id, a word and a meaning
//   G3  one word, one meaning: no word is defined twice in the whole course
//   G4  a meaning is at most 2 sentences of 18 words or fewer, at grade 6 or below
//   G5  a unit lists 2 to 5 different words
//   G6  each word appears in the page text, not only in the list
import { readingGrade, sentencesOf } from "./plain-english";
import { builtUnits, finish, type Loaded } from "./units";

const MOST_WORDS_IN_SENTENCE = 18;
const MOST_SENTENCES = 2;
const GRADE_LIMIT = 6;
const FEWEST_TERMS = 2;
const MOST_TERMS = 5;

export function meaningProblems(id: string, meaning: string): string[] {
  const found: string[] = [];
  const sentences = sentencesOf(meaning);
  if (sentences.length > MOST_SENTENCES) {
    found.push(`G4 "${id}": ${sentences.length} sentences; keep to ${MOST_SENTENCES}`);
  }
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).length;
    if (count > MOST_WORDS_IN_SENTENCE) found.push(`G4 "${id}": ${count}-word sentence`);
  }
  const grade = readingGrade(sentences);
  if (sentences.length > 0 && grade > GRADE_LIMIT) {
    found.push(`G4 "${id}": grade ${grade.toFixed(1)}; keep to ${GRADE_LIMIT}`);
  }
  if (/[;—]/.test(meaning)) found.push(`G4 "${id}": no semicolons or em dashes`);
  return found;
}

// The page without its picture and its "New words" list, so a word must live in the lesson itself.
export function lessonOf(page: string): string {
  let text = page;
  for (const heading of ["## New words", "## The story in one picture"]) {
    const start = text.indexOf(heading);
    if (start < 0) continue;
    const next = text.indexOf("\n## ", start + 1);
    text = text.slice(0, start) + (next < 0 ? "" : text.slice(next));
  }
  return text;
}

function termProblems(item: Loaded, definedIn: Map<string, string>): string[] {
  const found: string[] = [];
  const { unit, content } = item;
  const count = content.terms.length;
  if (count < FEWEST_TERMS || count > MOST_TERMS) {
    found.push(`G5 ${unit.slug}: lists ${count} words; keep to ${FEWEST_TERMS} to ${MOST_TERMS}`);
  }
  const lesson = lessonOf(item.page).toLowerCase();
  for (const term of content.terms) {
    if (term.id === "" || term.word === "" || term.meaning === "") {
      found.push(`G1 ${unit.slug}: a term is missing its id, word or meaning`);
    }
    const key = term.word.toLowerCase();
    const earlier = definedIn.get(key);
    if (earlier !== undefined)
      found.push(`G3 "${term.word}" is defined in ${earlier} and ${unit.slug}`);
    definedIn.set(key, unit.slug);
    found.push(...meaningProblems(term.id, term.meaning));
    if (!lesson.includes(key))
      found.push(`G6 ${unit.slug}: "${term.word}" is never used in the lesson`);
  }
  return found;
}

export function glossaryProblems(units: Loaded[]): string[] {
  const definedIn = new Map<string, string>();
  return units.flatMap((item) => termProblems(item, definedIn));
}

if (import.meta.main) {
  const units = await builtUnits();
  const good = `Every new word is defined once and used on its page (${units.length} units).`;
  finish(glossaryProblems(units), good, "glossary problems.");
}
