import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Why did sign-ups turn into active users so rarely in one August week?",
  production:
    "A product lead asks for numbers every day. Each answer must come from a checked query.",
  terms: [
    {
      id: "skill",
      word: "skill",
      meaning: "A small file with the words that wake it and one query to run.",
    },
    {
      id: "funnel",
      word: "funnel",
      meaning: "The steps from a new sign-up to an active user, with the people lost at each step.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> P{Asks for people}
  P -->|yes| R[Refuse, run nothing]
  P -->|no| S[Pick a skill by its words]
  S --> G[Check the query]
  G --> D[Run it on the funnel table]
  D --> A[Answer or chart spec]`,
  stuck: {
    correct: "Seven green badges, with the true week and rate in each answer.",
    wrong: "The analyst runs a query it should refuse, or your churn skill never wakes.",
    hint: "Check the query before you run it. Give your skill the word churn.",
    rows: [
      [
        "The Business rate",
        "The skill returns only the worst plan, so no other plan sits beside it.",
        "Remove the limit and filter on the worst week, so every plan shows.",
      ],
      [
        "The churn-risk-watch skill file is missing.",
        "The file is not in the skills folder.",
        "Save the file as apps/product-teammates/skills/churn-risk-watch.ts.",
      ],
      [
        "was allowed to run",
        "runSkill does not check the query first.",
        "In runSkill, call guardQuery and throw when it names a problem.",
      ],
      [
        "An email address reached a span.",
        "The question for emails ran a query.",
        "Refuse a personal question before any skill runs.",
      ],
    ],
  },
  breaks: [
    {
      file: "apps/product-teammates/src/analyst.ts",
      rule: "a bad query must be refused before it runs",
      find: "if (problem !== undefined) throw",
      replace: "if (problem === 'never') throw",
    },
    {
      file: "apps/product-teammates/src/analyst.ts",
      rule: "a question for personal data must be refused",
      find: 'const PERSONAL = ["email", "phone", "address"];',
      replace: 'const PERSONAL = ["nothing-at-all"];',
    },
    {
      file: "apps/product-teammates/src/analyst.ts",
      rule: "a skill is picked by its words",
      find: "skill.when.some((word) => text.includes(word))",
      replace: "skill.when.some((word) => word === text)",
    },
    {
      file: "apps/product-teammates/src/analyst.ts",
      rule: "a chart must come back as a spec",
      find: "if (skill.chart === true && found.length > 0)",
      replace: "if (skill.chart === 7)",
    },
    {
      file: "apps/product-teammates/skills/churn-risk-watch.ts",
      rule: "the churn skill must show every plan of the worst week",
      find: "ORDER BY churn_rate DESC`",
      replace: "ORDER BY churn_rate DESC LIMIT 1`",
    },
    {
      file: "apps/product-teammates/skills/activation-dip.ts",
      rule: "the dip skill must find the lowest activation",
      find: "ORDER BY activated::numeric / signups LIMIT 1",
      replace: "ORDER BY activated::numeric / signups DESC LIMIT 1",
    },
  ],
};
