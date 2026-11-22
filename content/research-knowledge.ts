import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "How does the product lead learn that a rival raised its price?",
  production: "A rival can change a price at night. The report must say what moved by morning.",
  terms: [
    {
      id: "snapshot",
      word: "snapshot",
      meaning: "A saved copy of a page as it looked on one day.",
    },
    {
      id: "noise",
      word: "page noise",
      meaning: "Text on a page that is not the content, like a cookie banner or a script.",
    },
  ],
  picture: `flowchart LR
  P[Rival page] --> C[Clean the noise]
  C --> S{Same as the last snapshot}
  S -->|yes| K[Say it did not change]
  S -->|no| R[Report before and now]
  R --> V[Save the new snapshot]`,
  stuck: {
    correct: "Six green badges, with the old and the new price in the report.",
    wrong: "The report shows a cookie banner or misses the text in a closed tab.",
    hint: "Clean the page first, then compare. Keep text from closed tabs.",
    rows: [
      [
        "The report lacks the old price.",
        "watchRival does not keep the last snapshot text.",
        "In watchRival, return the saved text as before.",
      ],
      [
        "The cookie banner is in the report.",
        "readPage does not cut the banner.",
        "In readPage, cut the banner, scripts and styles before you strip the tags.",
      ],
      [
        "The yearly price in the tab is missing.",
        "readPage dropped the closed tab.",
        "Strip tags only. Keep the text inside hidden sections.",
      ],
      [
        "The same page was saved twice.",
        "watchRival saves a snapshot when nothing changed.",
        "Save a snapshot only when the hash differs from the last one.",
      ],
    ],
  },
  breaks: [
    {
      file: "apps/product-teammates/src/research.ts",
      rule: "scripts must be cut from the page",
      find: "/<script[\\s\\S]*?<\\/script>/gi,",
      replace: "/<scrip[\\s\\S]*?<\\/scrip>/gi,",
    },
    {
      file: "apps/product-teammates/src/research.ts",
      rule: "the cookie banner must be cut",
      find: '/<div id="cookie-banner">',
      replace: '/<div id="banner">',
    },
    {
      file: "apps/product-teammates/src/research.ts",
      rule: "text in a closed tab must be kept",
      find: "/<style[\\s\\S]*?<\\/style>/gi,",
      replace: "/<style[\\s\\S]*?<\\/style>/gi,\n  /<section hidden>[\\s\\S]*?<\\/section>/gi,",
    },
    {
      file: "apps/product-teammates/src/research.ts",
      rule: "an unchanged page must be left alone",
      find: 'if (hash === last.hash) return { rival, status: "unchanged"',
      replace: 'if (hash === "never") return { rival, status: "unchanged"',
    },
    {
      file: "apps/product-teammates/src/research.ts",
      rule: "the report must keep the old text",
      find: 'return { rival, status: "changed", before: last.text, after };',
      replace: 'return { rival, status: "changed", before: "", after };',
    },
    {
      file: "apps/product-teammates/src/mission.ts",
      rule: "a question outside the job must get a template reply",
      find: 'if (rivalIn(question) !== undefined) return "answer";',
      replace: 'if (question.length > 0) return "answer";',
    },
  ],
};
