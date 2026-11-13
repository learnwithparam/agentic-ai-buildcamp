// Starter: a two-node graph, decide then pay. Both nodes are stubs. Make them real.
// By hand: bun assignment/graph.ts start run-1 7850, then: bun assignment/graph.ts resume run-1
import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/assignment";
const LENA_LIMIT_USD = 5000; // Replace this with your own approval rule from the build part.
const ledger = new pg.Pool({ connectionString: DATABASE_URL });

const RunState = Annotation.Root({
  runId: Annotation<string>(),
  amountUsd: Annotation<number>(),
  outcome: Annotation<string>(),
});
type Run = typeof RunState.State;

function decide(_run: Run) {
  console.log("node decide");
  // TODO: decide to pay.
  return {};
}

async function pay(_run: Run) {
  console.log("node pay");
  // TODO: above the limit, call interrupt() and wait for "approved".
  // TODO: write one row to the payments table. It must be safe to run twice.
  void LENA_LIMIT_USD;
  void ledger;
  return {};
}

function buildGraph() {
  // TODO: swap MemorySaver for PostgresSaver from @langchain/langgraph-checkpoint-postgres.
  const checkpointer = new MemorySaver();
  return new StateGraph(RunState)
    .addNode("decide", decide)
    .addNode("pay", pay)
    .addEdge(START, "decide")
    .addEdge("decide", "pay")
    .addEdge("pay", END)
    .compile({ checkpointer });
}

// start <run_id> <amount_usd> begins a run. resume <run_id> answers the pause on the same thread.
async function main() {
  const [command, runId, amountUsd] = process.argv.slice(2);
  const graph = buildGraph();
  const config = { configurable: { thread_id: runId } };
  const first = { runId, amountUsd: Number(amountUsd) };
  const input = command === "start" ? first : new Command({ resume: "approved" });
  const result = await graph.invoke(input, config);
  if ("__interrupt__" in result) {
    console.log("PAUSED waiting for Lena");
    setInterval(() => {}, 1000); // Stay alive, like an employee waiting for an answer.
    return;
  }
  console.log(`DONE ${result.outcome}`);
  process.exit(0);
}

await main();
