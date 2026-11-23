import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens when a customer reports a side effect and the agent just replies?",
  production:
    "The safety team reads each side effect report. Nothing is sent until a person says yes.",
  terms: [
    {
      id: "approval",
      word: "approval",
      meaning: "A saved request that waits until a named person says yes or no.",
    },
    {
      id: "outbox",
      word: "outbox",
      meaning: "A table that holds each reply that was approved and sent.",
    },
    {
      id: "memory",
      word: "memory",
      meaning: "Notes the agent keeps about one person, saved in the database.",
    },
  ],
  picture: `flowchart LR
  Q[Side effect report] --> P[Save an approval]
  P --> W[Wait in the inbox]
  W --> D{Reviewer decides}
  D -->|yes| O[Write one reply to the outbox]
  D -->|no| N[Send nothing]
  M[Notes per person] --> A[Agent]`,
  stuck: {
    correct: "Six green badges, and one reply sent only after a yes.",
    wrong: "A reply goes out before anyone approves it, or goes out twice.",
    hint: "Keep every approval in the database. Let decide act once, and only for the approver.",
    rows: [
      [
        "A model ran before a human saw the report.",
        "The graph never stops, so the agent answers a safety report at once.",
        "In waitForPerson, call interrupt so the run stops until a person decides.",
      ],
      [
        "A person without the approves grant decided.",
        "decide does not look for the approves grant.",
        "In decide, look up the grant for this person and topic and throw when it is missing.",
      ],
      [
        "The reply was sent twice.",
        "decide acts on a row that was already decided.",
        "In decide, select only rows whose status is pending.",
      ],
      [
        "A teammate read Alice's note.",
        "recall reads every note in the company.",
        "In recallFor, search the store under the company and then the person.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/approvals.ts",
      rule: "an adverse event must pause at interrupt and wait for a human",
      find: "interrupt(payload) as Decision;",
      replace: 'payload && ({ approved: true, approver: "nobody" } as Decision);',
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "only the named approver may decide",
      find: "if (grant.length === 0) throw",
      replace: "if (grant.length < 0) throw",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "an approval is decided once",
      find: "WHERE id = $1 AND status = 'pending'\",\n    [id],",
      replace: "WHERE id = $1 AND status <> 'none'\",\n    [id],",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "a rejection sends nothing",
      find: "|| !decision.approved) return;",
      replace: "|| decision.approved === undefined) return;",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "memory stays in its company",
      find: "store.search([tenant, person]",
      replace: "store.search([person]",
    },
  ],
};
