import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Which of these three OncoX labels is the one a patient should follow today?",
  production:
    "A real team gets a new label every few months. Each upload must retire the old one at once.",
  terms: [
    {
      id: "ingest",
      word: "ingest",
      meaning: "To read a file, store its text, and mark it ready for search.",
    },
    {
      id: "hash",
      word: "hash",
      meaning: "A short code made from a file. The same file always gives the same code.",
    },
    {
      id: "ocr",
      word: "OCR",
      meaning: "Software that reads letters from a picture. A scanned page needs it.",
    },
  ],
  picture: `flowchart LR
  F[PDF file] --> H{Same hash?}
  H -->|yes| S[Skip it]
  H -->|no| R[Read text with OCR when needed]
  R --> T[Store text]
  T --> A[One active label per brand and country]`,
  stuck: {
    correct: "Five green badges, and one active label for each brand and country.",
    wrong: "Two versions of the same label are both marked active.",
    hint: "Only the newest version that is in force today may be active.",
    rows: [
      [
        "The old OncoX dose is still active.",
        "The old version was never hidden when the new one arrived.",
        "After each upload, pick the newest version in force today.",
      ],
      [
        "The expired CardioZ draft is still active.",
        "The end date was never checked.",
        "Require the end date to be empty or not yet passed.",
      ],
      [
        "The scanned dose was not read.",
        "The text has line breaks, or the page was not read with OCR.",
        "Join the lines with single spaces, and read every page.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/ingestion.ts",
      rule: "a repeat upload of the same file must be skipped",
      find: "known.content_sha === sha",
      replace: "known.content_sha !== sha",
    },
    {
      file: "packages/core/src/ingestion.ts",
      rule: "an expired document must never be active",
      find: "o.effective <= $1 AND (o.expires IS NULL OR o.expires >= $1)",
      replace: "o.effective <= $1",
    },
    {
      file: "packages/core/src/ingestion.ts",
      rule: "only the newest version may be active",
      find: "AND d.version = (",
      replace: "AND d.version <= (",
    },
    {
      file: "packages/core/src/ingestion.ts",
      rule: "scanned text must be joined onto single lines",
      find: 'return text.replace(/\\s+/g, " ").trim();',
      replace: "return text;",
    },
  ],
};
