// Module 06: the same three-hop agent runs as a graph, saves every step and survives a crash.
import { MemorySaver } from "@langchain/langgraph";
import pg from "pg";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import {
  buildAgentGraph,
  type Decide,
  type Entry,
  openCheckpointer,
  RECURSION_LIMIT,
  resumeAgent,
  runAgent,
} from "../packages/core/src/agent-graph";
import { DATABASE_URL } from "../packages/core/src/db";
import { type Check, expect } from "../src/verify";

const CASE = "multi-hop-cited";
const PROBE_MS = 2000;
const STUDY = "neurocalm-us-study-summary";

function question(): string {
  const found = HCP_GOLDEN.cases.find((item) => item.name === CASE);
  expect(found !== undefined, `The golden set has no case named ${CASE}.`);
  return found.question;
}

function toolCount(trail: Entry[]): number {
  return trail.filter((entry) => entry.who === "tool").length;
}

// Plays the model the way a recording would: look up the study, read it, then answer.
export const threeHops: Decide = async (trail) => {
  const tools = toolCount(trail);
  if (tools === 0) return { tool: "find_study", input: "NeuroCalm" };
  if (tools === 1) return { tool: "read_document", input: trail[trail.length - 1].text };
  const text = "NeuroCalm users fell asleep 18 minutes faster, against 6 for the sugar pill.";
  return { answer: `${text} [${STUDY}]` };
};

const forever: Decide = async () => ({ tool: "find_study", input: "NeuroCalm" });

export async function postgresIsUp(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: PROBE_MS,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export const NOT_RUN =
  "NOT RUN: this check needs Postgres. Start it with: bun run up. The check did not run.";

export const checks: Check[] = [
  {
    name: "The three-hop question is answered by the graph",
    tryNext: "Add an edge from the act node back to the think node, so the model sees each result.",
    run: async () => {
      const graph = buildAgentGraph(new MemorySaver(), threeHops);
      const run = await runAgent(graph, question(), `three-hops-${Date.now()}`);
      expect(run.status === "done", "The graph did not reach an answer.");
      expect(toolCount(run.trail) === 2, "The graph did not make exactly two tool calls.");
      expect(run.answer.includes("18 minutes faster"), "The answer lacks the sleep gain.");
      expect(run.answer.includes(`[${STUDY}]`), "The answer does not cite the study.");
    },
  },
  {
    name: "A run that fails midway resumes from its last saved step",
    tryNext: "Pass the checkpointer to compile, then call the graph again with null input.",
    run: async () => {
      let broken = true;
      const failsOnce: Decide = async (trail) => {
        if (broken && toolCount(trail) === 1) throw new Error("the server stopped");
        return threeHops(trail);
      };
      const graph = buildAgentGraph(new MemorySaver(), failsOnce);
      const thread = `resume-${Date.now()}`;
      await runAgent(graph, question(), thread).then(
        () => expect(false, "The run should have failed."),
        () => undefined,
      );
      broken = false;
      const run = await resumeAgent(graph, thread);
      expect(run.status === "done", "The resumed run did not finish.");
      expect(toolCount(run.trail) === 2, "The resumed run repeated a tool call.");
    },
  },
  {
    name: "A killed process resumes on the same thread in Postgres",
    tryNext: "Build the graph with PostgresSaver and reuse the same thread_id after the restart.",
    run: async (trial) => {
      if (!(await postgresIsUp())) {
        console.log(NOT_RUN);
        return;
      }
      const thread = `crash-${Date.now()}-${trial}`;
      const child = Bun.spawn(["bun", "scripts/agent-graph-crash-worker.ts", thread], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await child.exited;
      expect(code !== 0, "The worker was supposed to be killed, but it exited cleanly.");
      const saver = await openCheckpointer();
      try {
        const graph = buildAgentGraph(saver, threeHops);
        const run = await resumeAgent(graph, thread);
        expect(run.status === "done", "The new process did not finish the saved thread.");
        expect(toolCount(run.trail) === 2, "The resumed run did not keep its first tool call.");
        expect(run.answer.includes("18 minutes faster"), "The resumed answer lacks the gain.");
      } finally {
        await saver.end();
      }
    },
  },
  {
    name: "The recursion limit stops a cycle",
    tryNext: "Pass recursionLimit in the config of every call to the graph.",
    run: async () => {
      let calls = 0;
      const counted: Decide = async (trail) => {
        calls += 1;
        return forever(trail);
      };
      const graph = buildAgentGraph(new MemorySaver(), counted);
      const run = await runAgent(graph, question(), `cycle-${Date.now()}`);
      expect(run.status === "stopped", "A cycle ended with an answer.");
      expect(calls <= RECURSION_LIMIT, `The cycle ran ${calls} model hops.`);
    },
  },
];
