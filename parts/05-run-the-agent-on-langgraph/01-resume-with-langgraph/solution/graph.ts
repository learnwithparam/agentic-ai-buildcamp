// Reference solution: a two-node graph. Decide, then pay. Paying above Lena's limit pauses the
// graph with interrupt(). Postgres keeps the pause, so a killed process can carry on.
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/assignment";
const LENA_LIMIT_USD = 5000;
const ledger = new pg.Pool({ connectionString: DATABASE_URL });

const RunState = Annotation.Root({
  runId: Annotation<string>(),
  amountUsd: Annotation<number>(),
  outcome: Annotation<string>(),
});
type Run = typeof RunState.State;

function decide(_run: Run) {
  console.log("node decide");
  return { outcome: "pay" };
}

// The pay node is safe to run twice: the unique key on run_id turns a second write into nothing.
async function pay(run: Run) {
  console.log("node pay");
  if (run.amountUsd > LENA_LIMIT_USD) {
    const answer = interrupt(`Lena must approve USD ${run.amountUsd}`);
    if (answer !== "approved") return { outcome: "refused" };
  }
  const write = "insert into payments (run_id, amount_usd) values ($1, $2) on conflict do nothing";
  await ledger.query(write, [run.runId, run.amountUsd]);
  return { outcome: "paid" };
}

function buildGraph(checkpointer: PostgresSaver) {
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
  const checkpointer = PostgresSaver.fromConnString(DATABASE_URL);
  await checkpointer.setup();
  const graph = buildGraph(checkpointer);
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
