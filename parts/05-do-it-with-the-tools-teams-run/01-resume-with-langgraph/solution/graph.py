"""Reference solution: decide, then pay. Paying above Lena's limit pauses with interrupt().

Postgres keeps the pause, so a killed process can carry on later on the same thread_id.
"""

import os
import sys
import time
from typing import TypedDict

import psycopg
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgres://postgres@localhost:54329/assignment"
)
LENA_LIMIT_USD = 5000
WRITE_PAYMENT = (
    "insert into payments (run_id, amount_usd) values (%s, %s) on conflict do nothing"
)


class Run(TypedDict):
    run_id: str
    amount_usd: int
    outcome: str


def decide(run: Run) -> dict:
    print("node decide", flush=True)
    return {"outcome": "pay"}


def pay(run: Run) -> dict:
    """Safe to run twice: the unique key on run_id turns a second write into nothing."""
    print("node pay", flush=True)
    if run["amount_usd"] > LENA_LIMIT_USD:
        answer = interrupt(f"Lena must approve USD {run['amount_usd']}")
        if answer != "approved":
            return {"outcome": "refused"}
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute(WRITE_PAYMENT, (run["run_id"], run["amount_usd"]))
    return {"outcome": "paid"}


def build_graph(checkpointer: PostgresSaver):
    builder = StateGraph(Run)
    builder.add_node("decide", decide)
    builder.add_node("pay", pay)
    builder.add_edge(START, "decide")
    builder.add_edge("decide", "pay")
    builder.add_edge("pay", END)
    return builder.compile(checkpointer=checkpointer)


def main() -> None:
    """start <run_id> <amount_usd> begins a run. resume <run_id> answers the pause."""
    command, run_id, *rest = sys.argv[1:]
    with PostgresSaver.from_conn_string(DATABASE_URL) as checkpointer:
        checkpointer.setup()
        graph = build_graph(checkpointer)
        config = {"configurable": {"thread_id": run_id}}
        first = {"run_id": run_id, "amount_usd": int(rest[0]) if rest else 0}
        result = graph.invoke(
            first if command == "start" else Command(resume="approved"), config
        )
    if "__interrupt__" in result:
        print("PAUSED waiting for Lena", flush=True)
        time.sleep(3600)  # Stay alive, like an employee waiting for an answer.
        return
    print(f"DONE {result['outcome']}", flush=True)


if __name__ == "__main__":
    main()
