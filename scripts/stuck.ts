// bun run stuck: every unit has stuck points, and each message they name is real.
//
//   S1  a built unit has stuck points (the entry lives in its content file)
//   S2  correct run, common wrong turn and hint are each at most 2 short sentences
//   S3  2 to 4 table rows, and every cell is filled
//   S4  the first cell of a row is a message the unit's checks really print
import { sentencesOf } from "./plain-english";
import { builtUnits, finish, type Loaded, readIfThere } from "./units";

const MOST_ROWS = 4;
const FEWEST_ROWS = 2;
const MOST_WORDS = 18;

function sentenceProblems(slug: string, label: string, text: string): string[] {
  const found: string[] = [];
  const sentences = sentencesOf(text);
  if (text.trim() === "") found.push(`S2 ${slug}: ${label} is empty`);
  if (sentences.length > 2) found.push(`S2 ${slug}: ${label} has ${sentences.length} sentences`);
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).length;
    if (count > MOST_WORDS) found.push(`S2 ${slug}: ${label} has a ${count}-word sentence`);
  }
  return found;
}

export function stuckProblems(item: Loaded, checksSource: string): string[] {
  const { slug } = item.unit;
  const { stuck } = item.content;
  const found = [
    ...sentenceProblems(slug, "correct run", stuck.correct),
    ...sentenceProblems(slug, "common wrong turn", stuck.wrong),
    ...sentenceProblems(slug, "hint", stuck.hint),
  ];
  if (stuck.rows.length < FEWEST_ROWS || stuck.rows.length > MOST_ROWS) {
    found.push(`S3 ${slug}: ${stuck.rows.length} rows; keep to ${FEWEST_ROWS} to ${MOST_ROWS}`);
  }
  for (const row of stuck.rows) {
    if (row.some((cell) => cell.trim() === "")) found.push(`S3 ${slug}: a row has an empty cell`);
    if (!checksSource.includes(row[0])) found.push(`S4 ${slug}: no check prints "${row[0]}"`);
  }
  return found;
}

if (import.meta.main) {
  const problems = (await builtUnits()).flatMap((item) => {
    const source = readIfThere(`checks/${item.unit.slug}.ts`);
    return stuckProblems(item, source);
  });
  finish(
    problems,
    "Every unit has stuck points, and every message they name is real.",
    "stuck-point problems.",
  );
}
