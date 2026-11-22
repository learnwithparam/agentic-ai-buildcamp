import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens at 8 am on Monday when nobody is at the keyboard?",
  production: "A rival moves at night. The team must notice, work once and wait for a human.",
  terms: [
    {
      id: "debounce",
      word: "debounce",
      meaning: "Turn a crowd of the same event into one piece of work.",
    },
    {
      id: "job-key",
      word: "job key",
      meaning: "A name for one piece of work. The same name never runs twice.",
    },
  ],
  picture: `flowchart LR
  E[Rival event] --> K{Job key is new}
  K -->|no| D[Dropped]
  K -->|yes| J[Job saved]
  C[Monday clock] --> K
  J --> W[Worker leases the job]
  W --> S[Draft and step saved together]
  S --> P[Briefing waits for approval]
  W -. server stops .-> R[Another worker resumes]
  R --> S`,
  stuck: {
    correct: "Five green badges, with one run for ten events and one draft after a crash.",
    wrong: "Ten events start ten runs, or a crash gives two briefings.",
    hint: "Key on the event, the rival and the window. Save the draft and step together.",
    rows: [
      [
        "Each rival must get its own run.",
        "The job key leaves out the rival.",
        "Put the rival name in the job key.",
      ],
      [
        "A later window got no new run.",
        "The job key ignores the time window.",
        "Add the window number to the job key.",
      ],
      [
        "The same week was drafted twice.",
        "The Monday job key does not hold the date.",
        "Build the key from the word briefing and the Monday date.",
      ],
      [
        "A briefing was drafted twice.",
        "The draft ran again after the restart.",
        "Return early when the saved step is 1.",
      ],
    ],
  },
  breaks: [
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "a crowd of events must share one key",
      find: "String(bucket)]",
      replace: "String(Math.random())]",
    },
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "each rival must have its own key",
      find: "[name, rival, String(bucket)]",
      replace: "[name, String(bucket)]",
    },
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "a new window must start a new run",
      find: "Math.floor(moment.getTime() / WINDOW_MS)",
      replace: "0",
    },
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "each Monday must have its own job",
      find: '["briefing", mondayOf(day)]',
      replace: '["briefing"]',
    },
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "a resumed job must not draft again",
      find: "if (job.step >= 1) return;",
      replace: "if (job.step >= 99) return;",
    },
    {
      file: "apps/product-teammates/src/always-on.ts",
      rule: "the briefing must name the rivals that moved",
      find: "const seen = await rivalsSeen();",
      replace: "const seen: string[] = [];",
    },
  ],
};
