import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "What stops an agent that asks for one more tool call, forever?",
  production:
    "A tool can be slow or broken. A turn limit stops one bad tool from running up a bill.",
  terms: [
    {
      id: "agent-loop",
      word: "agent loop",
      meaning:
        "A cycle: the model picks a tool, code runs it, and the result goes back to the model.",
    },
    {
      id: "tool-call",
      word: "tool call",
      meaning: "The model asking code to run one named tool with the inputs it chose.",
    },
    {
      id: "turn",
      word: "turn",
      meaning:
        "One trip to the model inside the loop. The agent counts turns to know when to stop.",
    },
  ],
  picture: `flowchart LR
  Q[Question] --> M[Model turn]
  M -->|picks a tool| T[Code runs the tool]
  T -->|result goes back| M
  M -->|writes an answer| C{Cites a document it read?}
  C -->|yes| A[Answer with citations]
  C -->|no| X[Refuse]
  M -->|turn limit reached| S[Stop with a message]`,
  stuck: {
    correct: "Four green badges, and the loop ends with an answer or a clear stop.",
    wrong: "The loop runs on and on because nothing counts the turns.",
    hint: "Count each trip to the model. Stop when the count reaches MAX_TURNS.",
    rows: [
      [
        "The loop did not stop at MAX_TURNS.",
        "The loop has no limit, or the limit is too high.",
        "Count each turn, and stop the loop after MAX_TURNS.",
      ],
      [
        "The model never saw the list of documents.",
        "The tool result was not added to the messages.",
        "After a tool runs, add its result to the messages for the next turn.",
      ],
      [
        "A number that is not in the document was accepted.",
        "The final answer was not checked against the documents the agent read.",
        "Check the final answer against the documents the agent read.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/agent.ts",
      rule: "a loop that never ends must stop at MAX_TURNS",
      find: "turn <= MAX_TURNS",
      replace: "turn <= 99",
    },
    {
      file: "packages/core/src/agent.ts",
      rule: "a tool result must go back to the model",
      find: 'messages.push({ role: "tool", content: results });',
      replace: 'messages.push({ role: "user", content: "Go on." });',
    },
    {
      file: "packages/core/src/agent.ts",
      rule: "an answer with a number the agent never read must be refused",
      find: "if (problem !== undefined) {",
      replace: 'if (problem === "never") {',
    },
  ],
};
