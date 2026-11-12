// One job: the trace shows invoke_agent and execute_tool spans for the read tools, and the ledger is unchanged.
import { behaviourRule } from "./lib";

export default [
  behaviourRule(
    "call-the-tools",
    "a job leaves a trace with invoke_agent and the three read tools, and changes nothing in the ledger",
    "wrap each job in an invoke_agent span and write an execute_tool span for every tool call to TRACE_DIR/<run_id>.jsonl",
  ),
];
