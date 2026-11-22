import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What stops a person from another company from reading your company's label?",
  production:
    "Two pharma companies share one agent. A field rep and a safety officer share it too.",
  terms: [
    {
      id: "clearance",
      word: "clearance",
      meaning: "A level on a person that says how private a document they may read.",
    },
    {
      id: "row-level-security",
      word: "row-level security",
      meaning: "A database rule that hides rows from a person who may not see them.",
    },
    {
      id: "token",
      word: "token",
      meaning: "A signed note that says who is asking. A forged note fails the check.",
    },
  ],
  picture: `flowchart LR
  P[Signed token] --> W[Who is asking]
  W --> C{can: company, role, clearance, territory}
  C -->|no| X[Refuse before any tool runs]
  C -->|yes| T[Run the tool]
  T --> D[Database wall hides the other rows]`,
  stuck: {
    correct: "Six green badges, and the code and the database agree for every person.",
    wrong: "The agent shows one company's label to another company.",
    hint: "Ask can() before any tool runs. Then let the database repeat the same rule.",
    rows: [
      [
        "A person from another company was not refused.",
        "permit does not compare the brand's company with the person's company.",
        "In permit, call can() with the brand in the question and refuse when it says no.",
      ],
      [
        "A field rep ran a report.",
        "canUse lets every role use the report tool.",
        "In ROLE_TOOLS, give a field rep the documents tool only.",
      ],
      [
        "A low clearance read a safety letter.",
        "can() skips the clearance check.",
        "In can(), refuse when the person's clearance is below the document's.",
      ],
      [
        "A forged token got through.",
        "personFrom does not verify the signature.",
        "In personFrom, verify the token with jwtVerify and use its subject.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/access.ts",
      rule: "a person from another company must be refused",
      find: "if (ownerOf(resource.brand) !== person.tenant) {",
      replace: 'if (ownerOf(resource.brand) === "nobody") {',
    },
    {
      file: "packages/core/src/access.ts",
      rule: "a field rep must not run reports",
      find: '["field-rep", ["documents"]],',
      replace: '["field-rep", ["documents", "bi"]],',
    },
    {
      file: "packages/core/src/access.ts",
      rule: "a low clearance must not read a private document",
      find: "if (person.clearance < clearanceOf(resource.type)) {",
      replace: "if (person.clearance < 0) {",
    },
    {
      file: "packages/core/src/access.ts",
      rule: "a field rep must read only the brands her territories carry",
      find: 'if (person.role === "field-rep" && !coversBrand(person, resource.brand)) {',
      replace: 'if (person.role === "nobody" && !coversBrand(person, resource.brand)) {',
    },
    {
      file: "packages/core/src/access.ts",
      rule: "the database wall must hide other companies",
      find: "AND p.tenant = ",
      replace: "AND p.tenant IS NOT NULL OR p.tenant = ",
    },
    {
      file: "packages/core/src/access.ts",
      rule: "the database query must run as the reader role",
      find: 'await run("SET LOCAL ROLE app_reader");',
      replace: 'await run("SELECT 1");',
    },
    {
      file: "packages/core/src/surfaces.ts",
      rule: "a request with no token must be refused",
      find: "if (signIn && person === undefined)",
      replace: 'if (signIn && person === "nobody")',
    },
  ],
};
