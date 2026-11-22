import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What stops a one line change from bringing back the old label?",
  production: "A release must never put a stale dose in front of a doctor.",
  terms: [
    {
      id: "gate",
      word: "release gate",
      meaning: "A check that must pass before a release goes out.",
    },
    {
      id: "regression",
      word: "regression",
      meaning: "A fault that comes back after it was fixed.",
    },
    {
      id: "stand-in",
      word: "stand-in model",
      meaning: "A fake model that copies the papers it reads. It tests the rules.",
    },
  ],
  picture: `flowchart LR
  C[A change] --> R[Run every golden case]
  R --> G{Any case failed}
  G -->|no| O[Gate open, release]
  G -->|yes| X[Gate closed]
  X --> N[Report names the case and the reason]`,
  stuck: {
    correct: "Four green badges, and a closed gate when the old label comes back.",
    wrong: "The gate stays open while a case fails.",
    hint: "Close the gate on any single failure, and name the case in the report.",
    rows: [
      [
        "A failed case did not close the gate.",
        "gate does not count the failures.",
        "In gate, set open to true only when the failure list is empty.",
      ],
      [
        "The report lacks the name.",
        "gate does not write the case name for each failure.",
        "In gate, start each failure line with the case name from the set.",
      ],
      [
        "The old label came back and the gate stayed open.",
        "The set no longer holds the stale dose case.",
        "Keep regression-caught in the golden set and run the whole set before a release.",
      ],
      [
        "One failure out of many left the gate open.",
        "gate treats a high pass rate as a pass.",
        "Open the gate only when every case passed.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/gate.ts",
      rule: "a failed case must be listed",
      find: "if (grade.ok) return;",
      replace: "if (grade.ok || !grade.ok) return;",
    },
    {
      file: "packages/core/src/gate.ts",
      rule: "one failure must close the gate",
      find: "open: failures.length === 0",
      replace: "open: failures.length < 2",
    },
    {
      file: "packages/core/src/gate.ts",
      rule: "the report must name the case",
      find: "set.cases[position].name",
      replace: "String(position)",
    },
    {
      file: "packages/core/src/gate.ts",
      rule: "the report must give the reason",
      find: 'grade.reasons.join(", ")',
      replace: '""',
    },
  ],
};
