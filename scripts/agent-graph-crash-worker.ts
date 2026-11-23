// A worker that dies in the middle of the graph. The langgraph-agent check starts it as a real process.
import { threeHops } from "../checks/langgraph-agent";
import { buildAgentGraph, openCheckpointer, runAgent } from "../packages/core/src/agent-graph";

const thread = process.argv[2] ?? "crash-thread";
const saver = await openCheckpointer();
const graph = buildAgentGraph(saver, async (trail) => {
  if (trail.some((entry) => entry.who === "tool")) process.kill(process.pid, "SIGKILL");
  return threeHops(trail);
});
await runAgent(graph, "How much faster did NeuroCalm users fall asleep?", thread);
