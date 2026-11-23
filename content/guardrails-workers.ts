import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens when a study PDF tells the agent to ignore its rules?",
  production: "A label changes overnight. The watcher runs once per change and survives a crash.",
  terms: [
    {
      id: "guardrail",
      word: "guardrail",
      meaning: "A check that stops bad text, a bad query or a bad bill before the agent acts.",
    },
    {
      id: "spend-cap",
      word: "spend cap",
      meaning: "The most one run may spend. The gateway reports what each model call cost.",
    },
    {
      id: "singleton-key",
      word: "singleton key",
      meaning: "A name on a job. Only one waiting or running job may hold that name.",
    },
    {
      id: "dead-letter",
      word: "dead letter queue",
      meaning: "A side queue for jobs that failed every try. A person looks at them later.",
    },
  ],
  picture: `flowchart LR
  E[Label change event] --> K{Key already waiting}
  K -->|yes| X[Ignore the copy]
  K -->|no| J[Save one job in Postgres]
  N[Nightly schedule] --> J
  J --> W[Worker runs the job]
  W -->|dies| L[Job expires and comes back]
  L --> W
  W -->|fails 3 times| D[Dead letter queue]
  W -->|done| F[Finished once]`,
  stuck: {
    correct: "Ten green badges, and one run for each event.",
    wrong: "An order in a document is followed, or one event runs twice.",
    hint: "Check text before the router. Give each event one key and one queue.",
    rows: [
      [
        "An order hidden in the text was followed.",
        "askTeam does not check the question for orders.",
        "In askTeam, call givesOrders and refuse before the router runs.",
      ],
      [
        "A run over the cap was not refused.",
        "underCap never compares the spend with the cap.",
        "In underCap, throw OverCap before call runs when the spend is at the cap.",
      ],
      [
        "Ten copies of one event made many jobs.",
        "enqueue sends the event without a singleton key.",
        "Send with singletonKey, on a queue with the exclusive policy.",
      ],
      [
        "A job that kept failing was not put in the dead letter queue.",
        "The queue has no deadLetter or no retry limit.",
        "Create the queue with retryLimit, retryBackoff and a deadLetter queue.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/team.ts",
      rule: "text that gives orders must be refused",
      find: "if (givesOrders(question)) return",
      replace: "if (givesOrders(question) && question === '') return",
    },
    {
      file: "packages/core/src/guardrails.ts",
      rule: "orders must be dropped from a document",
      find: "!givesOrders(line)",
      replace: "line !== ''",
    },
    {
      file: "packages/core/src/guardrails.ts",
      rule: "a query must not read raw rows",
      find: 'if (withoutCount.includes("*"))',
      replace: 'if (withoutCount.includes("*") && sql === "")',
    },
    {
      file: "packages/core/src/guardrails.ts",
      rule: "a run over its spend cap is refused before the model call",
      find: "if (ledger.spentUsd >= capUsd) {",
      replace: "if (ledger.spentUsd >= capUsd * 1000) {",
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "one event makes one job",
      find: 'policy: "exclusive",',
      replace: 'policy: "standard",',
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "a crashed job resumes at its saved step",
      find: "step: await savedStep(key)",
      replace: "step: 0",
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "a job that keeps failing lands in the dead letter queue",
      find: "    deadLetter: DEAD_QUEUE,\n",
      replace: "",
    },
  ],
};
