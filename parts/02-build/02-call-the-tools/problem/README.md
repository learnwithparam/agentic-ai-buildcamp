# Call the tools

## The problem

An agent that answers from what it already "knows" invents invoices. The clerk's job starts with evidence: the
invoice, the load, the rate confirmation and the proof of delivery, all from the world's tools. If those reads are
not in a trace, nobody can tell later whether the agent looked or guessed.

## Your challenge

When `POST /jobs` arrives with `{"job_id", "tenant", "trigger", "input": {"invoice_id"}}`:

1. Answer `202 {"job_id", "run_id"}` at once and do the work in the background.
2. Call `read_invoice`, `find_load`, `read_rate_confirmation` and `read_proof_of_delivery` on `WORLD_URL`, with
   the job's tenant in `X-Tenant`.
3. Write one `invoke_agent` span for the run and one `execute_tool` span per call to `TRACE_DIR/<run_id>.jsonl`,
   in the `employee.trace/v1` format from [CONTRACT.md](../../../../reference/CONTRACT.md).
4. Write nothing to the ledger yet.

```mermaid
flowchart LR
  J[POST /jobs] --> A[invoke_agent span]
  A --> T1[execute_tool read_invoice]
  A --> T2[execute_tool find_load]
  A --> T3[execute_tool read_rate_confirmation]
  A --> T4[execute_tool read_proof_of_delivery]
  T1 & T2 & T3 & T4 --> F[(traces/run_id.jsonl)]
```

The starter kits already do this. If you built your own, this step is where your loop first touches the world.

## Done when

- The trace for the job's `run_id` has an `invoke_agent` span and `execute_tool` spans for `read_invoice`,
  `read_rate_confirmation` and `read_proof_of_delivery`.
- The world's write log shows no write from reading.

```bash
bun run verify call-the-tools
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

- `No trace for run ...`: the file name must be the `run_id` you returned from `POST /jobs`, inside `TRACE_DIR`.
- `The trace has no invoke_agent span`: wrap the whole job in one root span.
- Each line must be one JSON object with `"format": "employee.trace/v1"`; other lines are skipped.

## Words you will use

- **Span**: one timed operation in a trace, such as a tool call or a model call.
- **Trace**: every span of one run, one JSON object per line.
- **Run id**: the id of one attempt at a job; the trace file is named after it.
