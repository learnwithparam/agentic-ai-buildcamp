import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens when a study PDF tells the agent to ignore its rules?",
  production:
    "A label can change overnight. The watcher must run once per change and survive a crash.",
  terms: [
    {
      id: "guardrail",
      word: "guardrail",
      meaning: "A check that stops bad text before the agent reads it.",
    },
    {
      id: "lease",
      word: "lease",
      meaning: "A short claim on a job. If the worker dies, the claim runs out.",
    },
    {
      id: "dead-letter",
      word: "dead letter list",
      meaning: "Jobs that failed every try. A person looks at them later.",
    },
  ],
  picture: `flowchart LR
  E[Label change event] --> K{Key already seen}
  K -->|yes| X[Ignore the copy]
  K -->|no| J[Save one job]
  J --> W[Worker leases the job]
  W -->|dies| L[Lease runs out]
  L --> W
  W -->|fails 3 times| D[Dead letter list]
  W -->|done| F[Finished once]`,
  stuck: {
    correct: "Six green badges, and one run for each event.",
    wrong: "An order in a document is followed, or one event runs twice.",
    hint: "Check text before the router. Give each event one key and one lease.",
    rows: [
      [
        "An order hidden in the text was followed.",
        "askTeam does not check the question for orders.",
        "In askTeam, call givesOrders and refuse before the router runs.",
      ],
      [
        "Ten copies of one event made many jobs.",
        "enqueue adds a row each time.",
        "Insert with ON CONFLICT (key) DO NOTHING and return whether the row is new.",
      ],
      [
        "The new worker did not start at the saved step.",
        "claim does not take a job whose lease ran out.",
        "In claim, also select running jobs whose lease_until is in the past.",
      ],
      [
        "A job that kept failing was not put in the dead letter list.",
        "fail never stops retrying.",
        "In fail, mark the job dead once attempts reach the last try.",
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
      file: "packages/core/src/jobs.ts",
      rule: "one event makes one job",
      find: "ON CONFLICT (key) DO NOTHING",
      replace: "ON CONFLICT (key) DO UPDATE SET payload = $2",
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "a crashed job must be taken by the next worker",
      find: "OR (status = 'running' AND lease_until < now())",
      replace: "OR (status = 'running' AND lease_until < now() - interval '1 day')",
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "a job that keeps failing must stop",
      find: "if (job.attempts >= MAX_ATTEMPTS) {",
      replace: "if (job.attempts >= MAX_ATTEMPTS * 100) {",
    },
    {
      file: "packages/core/src/jobs.ts",
      rule: "a failed job must wait before it retries",
      find: "run_after = now() + $3 * interval '1 second' WHERE id = $1",
      replace: "run_after = now() WHERE id = $1 AND $3 > 0",
    },
  ],
};
