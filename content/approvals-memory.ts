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
        "The agent answers a safety report before it saves an approval.",
        "In pauseForHuman, save the approval and return the waiting message.",
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
        "In recall, filter by the company and by the person.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/team.ts",
      rule: "a safety report must wait for a human",
      find: 'if (result.route !== "escalate" && result.route !== "approve") return result;',
      replace: 'if (result.route !== "nothing") return result;',
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "only the named approver may decide",
      find: "if (allowed.rows.length === 0) throw",
      replace: "if (allowed.rows.length < 0) throw",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "an approval is decided once",
      find: "WHERE id = $1 AND status = 'pending'",
      replace: "WHERE id = $1 AND status <> 'none'",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "a rejection sends nothing",
      find: "if (approved) {",
      replace: "if (approved || !approved) {",
    },
    {
      file: "packages/core/src/approvals.ts",
      rule: "memory stays with its owner",
      find: "WHERE tenant = $1 AND person = $2 ORDER BY created",
      replace: "WHERE tenant = $1 AND $2 <> '' ORDER BY created",
    },
  ],
};
