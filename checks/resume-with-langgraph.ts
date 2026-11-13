// resume-with-langgraph: the closing part. The learner's graph runs as a program against Postgres.
// It must stop at an interrupt, survive a SIGKILL, resume on the same thread_id and pay once.
// The logic is in checks/lib/langgraph-assignment.ts.
import type { Rule, RuleAnswer } from "../scripts/verify";
import { evaluate, LINE_SAYS } from "./lib/langgraph-assignment";

const TRY_NEXT = [
  "pin it: bun add @langchain/langgraph@1.7.4, or uv add langgraph==1.2.21",
  "call interrupt() in pay above the limit, with the Postgres checkpointer",
  "keep the checkpointer in Postgres, and resume on the same thread_id",
  "insert with on conflict do nothing, and only after the answer is approved",
  "pay straight away when the amount is at or under the limit, with no interrupt",
];

async function lineAnswer(dir: string, index: number): Promise<RuleAnswer> {
  const found = await evaluate(dir);
  const results = Object.values(found).map((lines) => lines[index].result);
  if (results.length === 0 || results.includes("fail")) return false;
  return results.includes("skipped") ? "skipped" : true;
}

const rules: Rule[] = LINE_SAYS.map((says, index) => ({
  says,
  test: (dir) => lineAnswer(dir, index),
  tryNext: TRY_NEXT[index],
}));

export default rules;
