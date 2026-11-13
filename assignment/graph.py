"""Starter: a two-node graph, decide then pay. Both nodes are stubs. Make them real.

Run it by hand:  uv run --project assignment python assignment/graph.py start run-1 7850
then:            uv run --project assignment python assignment/graph.py resume run-1
"""

import os
import sys
import time
from typing import TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://postgres@localhost:54329/assignment")
LENA_LIMIT_USD = 5000  # Replace this with your own approval rule from the build part.


class Run(TypedDict):
    run_id: str
    amount_usd: int
    outcome: str


def decide(run: Run) -> dict:
    print("node decide", flush=True)
    # TODO: decide to pay.
    return {}


def pay(run: Run) -> dict:
    print("node pay", flush=True)
    # TODO: above the limit, call interrupt() and wait for "approved".
    # TODO: write one row to the payments table with psycopg. It must be safe to run twice.
    return {}


def build_graph():
    # TODO: swap InMemorySaver for PostgresSaver from langgraph.checkpoint.postgres.
    builder = StateGraph(Run)
    builder.add_node("decide", decide)
    builder.add_node("pay", pay)
    builder.add_edge(START, "decide")
    builder.add_edge("decide", "pay")
    builder.add_edge("pay", END)
    return builder.compile(checkpointer=InMemorySaver())


def main() -> None:
    """start <run_id> <amount_usd> begins a run. resume <run_id> answers the pause."""
    command, run_id, *rest = sys.argv[1:]
    graph = build_graph()
    config = {"configurable": {"thread_id": run_id}}
    first = {"run_id": run_id, "amount_usd": int(rest[0]) if rest else 0}
    result = graph.invoke(first if command == "start" else Command(resume="approved"), config)
    if "__interrupt__" in result:
        print("PAUSED waiting for Lena", flush=True)
        time.sleep(3600)  # Stay alive, like an employee waiting for an answer.
        return
    print(f"DONE {result.get('outcome')}", flush=True)


if __name__ == "__main__":
    main()
