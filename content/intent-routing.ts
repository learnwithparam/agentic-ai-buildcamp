import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Should a question about a sorting algorithm cost the same as a question about a dose?",
  production:
    "A router keeps cost and risk down. Cheap paths answer at once, and risky ones reach a person.",
  terms: [
    {
      id: "router",
      word: "router",
      meaning: "Code that reads a question and picks a path for it before any model runs.",
    },
    {
      id: "template",
      word: "template",
      meaning: "A fixed reply that needs no model. It is fast, free and always the same.",
    },
    {
      id: "escalate",
      word: "escalate",
      meaning: "To hand a case to a person who can decide. A safety report is escalated.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> R{Router}
  R -->|trivia| T[Template reply]
  R -->|off-label| X[Refuse]
  R -->|safety report| E[Escalate to a person]
  R -->|medical question| A[Agent loop]`,
  stuck: {
    correct: "Five green badges, and a trace with no model span for the trivia question.",
    wrong: "Every question reaches the model, even a question about sorting.",
    hint: "Decide the path from the words in the question, before any model call.",
    rows: [
      [
        "The template path still called a model.",
        "The handler runs the agent for every route.",
        "Return the fixed reply for each route that is not answer.",
      ],
      [
        "wanted escalate.",
        "The safety words were never checked, or they were checked too late.",
        "Check for safety words before every other rule.",
      ],
      [
        "wanted refuse.",
        "The off-label words were never checked.",
        "Refuse a question that asks what a drug works for off the label.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/router.ts",
      rule: "a safety report must be escalated",
      find: "if (has(text, SAFETY_WORDS))",
      replace: "if (has(text, []))",
    },
    {
      file: "packages/core/src/router.ts",
      rule: "an off-label request must be refused",
      find: "if (has(text, OFF_LABEL_WORDS))",
      replace: "if (has(text, []))",
    },
    {
      file: "packages/core/src/router.ts",
      rule: "trivia must never reach the agent",
      find: "if (!namesBrand(text) && !has(text, TOPIC_WORDS))",
      replace: "if (has(text, []))",
    },
    {
      file: "packages/core/src/router.ts",
      rule: "a templated path must not call the model",
      find: 'if (decision.route === "answer") return answer(question);',
      replace: "return answer(question);",
    },
  ],
};
