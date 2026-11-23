import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What stops the agent from inventing a dose when the documents say nothing?",
  production:
    "A reviewer checks each answer line by line. A cited answer lets them find the source fast.",
  terms: [
    {
      id: "grounded",
      word: "grounded",
      meaning: "Based on documents the agent was shown. A grounded answer has a source.",
    },
    {
      id: "citation",
      word: "citation",
      meaning: "A note that names the document an answer came from.",
    },
    {
      id: "claim",
      word: "claim",
      meaning: "What the model says. Code must check it, because the model can be wrong.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> D[Active documents only]
  D -->|none| R[Refuse before the model]
  D --> M[Model writes an answer]
  M --> C{Cites a shown document and uses only its numbers?}
  C -->|yes| A[Answer with citations]
  C -->|no| X[Refuse]`,
  stuck: {
    correct: "Seven green badges, and every answer names its source.",
    wrong: "The agent accepts a dose that is in no document.",
    hint: "The model's reply is a claim. Check its numbers against the cited document.",
    rows: [
      [
        "A number that is not in the label was accepted.",
        "The answer was never checked against the cited document.",
        "Check every number in the answer against the cited document.",
      ],
      [
        "An uncited answer was accepted.",
        "The check does not look for a citation.",
        "Refuse an answer that cites no document, or one that was never shown.",
      ],
      [
        "The old dose reached the prompt.",
        "The prompt was built from every document, not only the active ones.",
        "Build the prompt from the active documents only.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/grounded.ts",
      rule: "an answer with no citation must be refused",
      find: "if (cited.length === 0)",
      replace: "if (cited.length === 99)",
    },
    {
      file: "packages/core/src/grounded.ts",
      rule: "a citation to an unseen document must be refused",
      find: "!cited.every((slug) => shown.includes(slug))",
      replace: "cited.length === 99",
    },
    {
      file: "packages/core/src/grounded.ts",
      rule: "a number outside the source must be caught",
      find: ".match(/\\d+(\\.\\d+)?/g)",
      replace: ".match(/\\d+x/g)",
    },
    {
      file: "packages/core/src/grounded.ts",
      rule: "no document means no model call",
      find: "if (documents.length === 0)",
      replace: "if (documents.length === 99)",
    },
    {
      file: "packages/core/src/grounded.ts",
      rule: "a silent model must lead to a refusal",
      find: "if (reply === NOT_THERE)",
      replace: 'if (reply === "")',
    },
  ],
};
