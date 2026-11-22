import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Why does a plain chatbot quote the old OncoX dose?",
  production:
    "The same stack runs in the company's own cloud. The seed becomes the real label library.",
  terms: [
    {
      id: "naive-agent",
      word: "naive agent",
      meaning: "An agent that puts all it has into one prompt. It trusts whatever comes back.",
    },
    {
      id: "seed",
      word: "seed",
      meaning: "Made-up data that all learners load. It is the same for everyone.",
    },
    {
      id: "golden-set",
      word: "golden set",
      meaning: "A list of questions with the right answers. It grades the agent.",
    },
  ],
  picture: `flowchart LR
  Q[A question] --> P[One big prompt]
  D[Every label and every doctor] --> P
  P --> M[The model]
  M --> A[An answer that may be old]`,
  stuck: {
    correct: "Every check shows a green badge. The scoreboard stays low on purpose.",
    wrong: "The stack is not running, so Postgres and Phoenix both fail.",
    hint: "Start Docker first. Then run bun run up again.",
    rows: [
      [
        "Postgres has no people. Run bun run up first.",
        "The seed was never loaded.",
        "Run bun run up.",
      ],
      [
        "Phoenix did not answer on port 6006.",
        "Phoenix is still starting.",
        "Wait ten seconds and run the check again.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/seed-load.ts",
      rule: "the seed must be loaded into Postgres",
      find: 'await rows(readFileSync(join(OUTPUT, "sql", "seed.sql"), "utf8"));',
      replace: "await rows('SELECT 1');",
    },
    {
      file: "apps/hcp-showcase/src/naive.ts",
      rule: "the naive prompt must carry every prescriber email",
      find: "[item.name, item.npi, item.email]",
      replace: "[item.name, item.npi]",
    },
  ],
};
