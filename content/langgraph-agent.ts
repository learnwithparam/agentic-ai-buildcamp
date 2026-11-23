import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What happens to a half-done answer when the server dies?",
  production:
    "A real server restarts after every deploy. A saved thread lets the agent finish the work it began.",
  terms: [
    {
      id: "graph",
      word: "graph",
      meaning: "Boxes joined by arrows. Each box is one step, and each arrow says what runs next.",
    },
    {
      id: "thread",
      word: "thread",
      meaning: "One run of the agent, saved under one id. Use the same id to carry on later.",
    },
    {
      id: "recursion-limit",
      word: "recursion limit",
      meaning: "The most steps one run may take. It stops a loop that never ends.",
    },
  ],
  picture: `flowchart LR
  S[Question] --> T[Think: the model picks a step]
  T -->|tool| A[Act: run the tool]
  A --> T
  T -->|answer| E[Answer]
  T -.-> P[(Postgres saves each step)]
  A -.-> P`,
  stuck: {
    correct: "Four green badges. The killed run finishes in a new process.",
    wrong: "The new process starts from the question and repeats work.",
    hint: "Compile the graph with the checkpointer. Then call it again with null input.",
    rows: [
      [
        "The graph did not reach an answer.",
        "The act node does not lead back to the think node.",
        "Add an edge from act to think.",
      ],
      [
        "The new process did not finish the saved thread.",
        "No step was saved, or the thread id changed.",
        "Compile with the Postgres checkpointer and reuse the same thread id.",
      ],
      [
        "A cycle ended with an answer.",
        "The cycle check ran a model that finished by itself.",
        "Use a model step that never answers, then check the limit stops it.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/agent-graph.ts",
      rule: "the graph must save its steps with the checkpointer",
      find: ".compile({ checkpointer })",
      replace: ".compile({})",
    },
    {
      file: "packages/core/src/agent-graph.ts",
      rule: "a recursion limit must stop a cycle",
      find: "recursionLimit: RECURSION_LIMIT,",
      replace: "recursionLimit: 1000,",
    },
    {
      file: "packages/core/src/agent-graph.ts",
      rule: "every tool result must go back to the model",
      find: '.addEdge("act", "think")',
      replace: '.addEdge("act", END)',
    },
  ],
};
