// The words and pictures each unit owns. One file per unit: content/<slug>.ts.
// Keeping them in one place means parallel work never edits the same file.

export type Term = { id: string; word: string; meaning: string };

// A stuck row: what the learner sees (a message a check really prints), why, and the fix.
export type StuckRow = [seen: string, why: string, fix: string];

export type Stuck = {
  correct: string; // what a correct run looks like, in one short sentence
  wrong: string; // the most common wrong turn, in one short sentence
  hint: string; // one nudge that does not give the answer
  rows: StuckRow[];
};

// A planted bug: the promise test must fail when this edit is applied.
export type Break = { file: string; rule: string; find: string; replace: string };

export type UnitContent = {
  opening: string; // the question that opens "See it fail first"; unique across units
  production: string; // what this becomes in a real company
  terms: Term[]; // 2 to 5 new words, each defined once in the whole course
  picture: string; // Mermaid source for "The story in one picture"
  stuck: Stuck;
  breaks: Break[];
};
