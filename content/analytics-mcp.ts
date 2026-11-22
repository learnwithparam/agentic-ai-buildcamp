import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Why does the agent need a tool for numbers instead of a table pasted into the prompt?",
  production:
    "A sales lead asks about one territory. The answer must show a number, never a doctor's email.",
  terms: [
    {
      id: "schema",
      word: "schema",
      meaning: "A named folder of tables. Each workspace keeps its tables in its own schema.",
    },
    {
      id: "aggregate",
      word: "aggregate",
      meaning: "One number that sums up many rows, such as a total or an average.",
    },
    {
      id: "guard",
      word: "guard",
      meaning: "Code that checks a query before it runs. It refuses anything unsafe.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> S[Read the table shapes]
  S --> W[Model writes one query]
  W --> G{Guard: select only, own tables, no private columns}
  G -->|no| X[Refuse]
  G -->|yes| R[Run the query]
  R --> A[Numbers only go back]`,
  stuck: {
    correct: "Six green badges, and no private value in any span.",
    wrong: "The agent reads a doctor's email through the BI tool.",
    hint: "The guard checks the query text. Check it for private column words first.",
    rows: [
      [
        "A query for emails was run.",
        "The guard does not look for private column words.",
        "In guardQuery, refuse a query that names email, npi or a name column.",
      ],
      [
        "Another workspace was readable.",
        "The guard does not check which schema each table belongs to.",
        "In guardQuery, allow only tables of this workspace.",
      ],
      [
        "The prescriber table is visible to the agent.",
        "The shape list was not limited to the workspace schema.",
        "In inspectSchema, read the columns of the workspace schema only.",
      ],
      [
        "A write was allowed.",
        "The guard does not require a select query.",
        "In guardQuery, allow only select, and only one statement.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/bi.ts",
      rule: "only a select query may run",
      find: "if (!/^\\s*select\\b/i.test(sql))",
      replace: "if (sql.length === 0)",
    },
    {
      file: "packages/core/src/bi.ts",
      rule: "only one statement may run",
      find: '.includes(";")',
      replace: '.includes("~~")',
    },
    {
      file: "packages/core/src/bi.ts",
      rule: "private columns must be refused",
      find: "if (PERSONAL_WORD.test(sql))",
      replace: "if (sql.length === 0)",
    },
    {
      file: "packages/core/src/bi.ts",
      rule: "another workspace must be refused",
      find: "if (outside !== undefined)",
      replace: "if (tables.length === 99)",
    },
    {
      file: "packages/core/src/bi.ts",
      rule: "the query span must record a row count",
      find: "setAttributes({ sql, row_count: result.length });",
      replace: "setAttributes({ sql });",
    },
    {
      file: "packages/core/src/bi.ts",
      rule: "each workspace shows only its own tables",
      find: "WHERE table_schema = $1 ORDER BY",
      replace: "WHERE table_schema = 'pharma_a' ORDER BY",
    },
  ],
};
