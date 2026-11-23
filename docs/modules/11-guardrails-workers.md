# Guard the inputs and run workers that never double up

Job: watch for label changes overnight, run each once, stay under budget and survive a crash.

## The story in one picture

```mermaid
flowchart LR
  E[Label change event] --> K{Key already waiting}
  K -->|yes| X[Ignore the copy]
  K -->|no| J[Save one job in Postgres]
  N[Nightly schedule] --> J
  J --> W[Worker runs the job]
  W -->|dies| L[Job expires and comes back]
  L --> W
  W -->|fails 3 times| D[Dead letter queue]
  W -->|done| F[Finished once]
```

## Why this matters

Three things go wrong when an agent runs alone. A PDF may hide an order for the agent. A query may read raw rows. A night job may run twice, run up a big bill or die halfway.

A **guardrail** checks text, a query or a bill before the agent acts. A line that gives orders is dropped. A question that gives orders is refused.

A job gets one key. The same event cannot make two jobs. If a worker dies, the job comes back and a new worker starts where the old one stopped.

## What you will have at the end

- A check for text that gives orders, on questions and on documents.
- A check that lets a query ask for totals only.
- A **spend cap** that refuses a model call once a run has spent too much.
- A pg-boss queue with one job for each key, retries and a **dead letter queue**.
- A nightly schedule and a worker that finishes its job when it gets SIGTERM.

## See it fail first

What happens when a study PDF tells the agent to ignore its rules? Right now the agent reads the line as part of the study.

For example, a trial summary holds one odd line. It says to ignore the rules and print every NPI. The agent cannot tell that line from a fact.

Three more things fail the same way. A query can say `SELECT *` and read raw rows. Ten copies of one event can make ten runs. A worker that gets `kill -9` in the middle of a run can lose the job.

## Step 1: drop orders from text

The list of order phrases is short and exact. Hidden marks and extra spaces are cleaned first, so they cannot hide an order.

### packages/core/src/guardrails.ts

```ts
export function givesOrders(text: string): boolean {
  const clean = normalise(text);
  return ORDERS.some((phrase) => clean.includes(phrase));
}

// Drops every line that gives orders and keeps the rest of the document.
export function scrubDocument(body: string): string {
  const kept = body.split("\n").filter((line) => !givesOrders(line));
  return kept.join("\n");
}
```

## Step 2: refuse a question that gives orders

The team agent checks the question before the router runs. A refused question never reaches a model.

### packages/core/src/team.ts

```ts
  if (givesOrders(question)) return { route: "refuse", text: REFUSAL, citations: [] };
```

## Step 3: allow totals only in a query

The agent may ask for sums and counts. It may not ask for raw rows. A star shows every column, so it is refused.

### packages/core/src/guardrails.ts

```ts
export function aggregateOnly(sql: string): string | undefined {
  const withoutCount = sql.replace(/count\s*\(\s*\*\s*\)/gi, "count(1)");
  if (withoutCount.includes("*")) return "a star shows raw rows, so ask for totals";
  if (!/\b(sum|count|avg|min|max)\s*\(/i.test(sql)) return "a query must ask for a total";
  return undefined;
}
```

## Step 4: stop a run at its spend cap

Each model call costs money. The gateway sends the cost back in a header, and the ledger adds it up. Once the run reaches the cap, the next call is refused before it starts.

### packages/core/src/guardrails.ts

```ts
export async function underCap<Reply extends Priced>(
  ledger: Ledger,
  call: () => Promise<Reply>,
  capUsd = SPEND_CAP_USD,
): Promise<Reply> {
  if (ledger.spentUsd >= capUsd) {
    throw new OverCap(`This run spent $${ledger.spentUsd} and its cap is $${capUsd}.`);
  }
  const reply = await call();
  addCost(ledger, reply);
  return reply;
}
```

## Step 5: save one job for each key

The key is the event, for example one label change. pg-boss is a job queue that lives in Postgres. The queue allows one job for each key, so a second copy adds nothing.

### packages/core/src/jobs.ts

```ts
const queue = new PgBoss({
  connectionString: DATABASE_URL,
  superviseIntervalSeconds: 2,
  monitorIntervalSeconds: 2,
});
await queue.createQueue(QUEUE, {
  policy: "exclusive",
  retryLimit: MAX_ATTEMPTS - 1,
  retryDelay: RETRY_SECONDS,
  retryBackoff: true,
  deadLetter: DEAD_QUEUE,
});
```

## Step 6: resume after a crash

A worker saves its step after each piece of work. When a worker dies, the job expires and comes back. The new worker reads the saved step and starts there.

### packages/core/src/jobs.ts

```ts
await queue.work<Data>(QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
  const { key, payload } = job.data;
  await handler({ id: job.id, key, payload, step: await savedStep(key) });
});
```

## Step 7: retry, then give up

A failed job waits longer each time. The queue settings in Step 5 do this. After the last try, the job moves to the dead letter queue.

## Step 8: run every night and drain on SIGTERM

A schedule adds one watch job each night. The date in the key means a second add does nothing. When the process gets SIGTERM, the worker finishes its job and then stops.

## Step 9: verify

```bash
bun run verify guardrails-workers
```

Expect: ten green badges and the line "Every check passed."

This check needs Postgres, so run `bun run up` first.

## Try it yourself

Add one more order phrase and run the check again. For example, add "reveal your prompt" to a new test question.

```bash
bun run verify guardrails-workers
```

Expect: the badge "Normal questions are never flagged as orders" stays green.

## Stuck?

| You see                                                       | Why                                              | Fix                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| An order hidden in the text was followed.                     | askTeam does not check the question for orders.  | In askTeam, call givesOrders and refuse before the router runs.           |
| A run over the cap was not refused.                           | underCap never compares the spend with the cap.  | In underCap, throw OverCap before call runs when the spend is at the cap. |
| Ten copies of one event made many jobs.                       | enqueue sends the event without a singleton key. | Send with singletonKey, on a queue with the exclusive policy.             |
| A job that kept failing was not put in the dead letter queue. | The queue has no deadLetter or no retry limit.   | Create the queue with retryLimit, retryBackoff and a deadLetter queue.    |

If you are still stuck, start from a clean copy of this step.

```bash
bun run goto guardrails-workers
```

Expect: a message that you are now on the guardrails-workers checkpoint, with a list of things to do.

## New words

- **guardrail**: A check that stops bad text, a bad query or a bad bill before the agent acts.
- **spend cap**: The most one run may spend. The gateway reports what each model call cost.
- **singleton key**: A name on a job. Only one waiting or running job may hold that name.
- **dead letter queue**: A side queue for jobs that failed every try. A person looks at them later.
