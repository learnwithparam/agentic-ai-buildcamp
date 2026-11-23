import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Can Priya read the memo of a secret deal by asking nicely?",
  production: "Two teams share one app. A secret from one team must never reach the other.",
  terms: [
    {
      id: "workspace",
      word: "workspace",
      meaning: "A space for one team. Its files and notes stay inside it.",
    },
    {
      id: "member-grant",
      word: "member grant",
      meaning: "A saved fact that says a person belongs to a workspace.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> M{Member grant found}
  M -->|no| R[Refuse]
  M -->|yes| F[Read the file or the notes]
  W[Briefing written] --> P[Waits as a row]
  P --> A{Approver is not the writer}
  A -->|yes| U[Published]
  A -->|no| X[Refused]`,
  stuck: {
    correct: "Five green badges, with the memo shown only to its members.",
    wrong: "A person outside the workspace reads the memo, or a writer approves their own work.",
    hint: "Check the member grant before you read. Check the writer before you approve.",
    rows: [
      [
        "The deal size reached a person outside.",
        "readMemo does not look for a member grant.",
        "In readMemo, return nothing unless isMember is true.",
      ],
      [
        "Another person's tone reached Priya.",
        "recallTone does not filter on the person.",
        "Add the person to the where clause of the tone query.",
      ],
      [
        "A tone from another workspace reached Lena.",
        "recallTone does not filter on the workspace.",
        "Add the workspace to the where clause of the tone query.",
      ],
      [
        "The writer approved it.",
        "approveBriefing does not compare the writer with the approver.",
        "Throw when the writer and the approver are the same person.",
      ],
    ],
  },
  breaks: [
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "a member grant must be required for the memo",
      find: "if (!(await isMember(person, workspace))) return undefined;",
      replace: "if (workspace === '') return undefined;",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "tone notes must stay with one person",
      find: "`SELECT note FROM tone_notes WHERE person = $1 AND workspace = $2",
      replace: "`SELECT note FROM tone_notes WHERE $1 = $1 AND workspace = $2",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "tone notes must stay inside one workspace",
      find: "AND workspace = $2\n     ORDER BY id DESC LIMIT 1`",
      replace: "AND $2 = $2\n     ORDER BY id DESC LIMIT 1`",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "a writer must not approve their own briefing",
      find: "if (briefing.writer === approver)",
      replace: "if (briefing.writer === 'nobody')",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "only an approver may publish",
      find: "if (allowed.rows.length === 0) throw",
      replace: "if (allowed.rows.length === 7) throw",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "a briefing must be decided once",
      find: "WHERE id = $1 AND status = 'pending'\", [id]);",
      replace: 'WHERE id = $1", [id]);',
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "the database wall must hide notes from outsiders",
      find: "USING (person = current_setting('app.person', true)",
      replace: "USING (true OR person = current_setting('app.person', true)",
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "a briefing must wait for a person to approve it",
      find: 'if (state.status !== "approved") return {};',
      replace: 'if (state.status === "nothing") return {};',
    },
    {
      file: "apps/product-teammates/src/workspace.ts",
      rule: "the graph must stop and resume on the same thread",
      find: "const answer = interrupt(",
      replace: "const answer = ((_: unknown) => ({ approver: 'lena', approved: true }))(",
    },
  ],
};
