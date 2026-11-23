# Research rival pricing pages

Job: Tell the product lead when a rival changes its price.

## The story in one picture

```mermaid
flowchart LR
  P[Rival page] --> C[Clean the noise]
  C --> S{Same as the last snapshot}
  S -->|yes| K[Say it did not change]
  S -->|no| R[Report before and now]
  R --> V[Save the new snapshot]
```

## Why this matters

Brightloop is a software company. Its product lead, Priya, wants to know when a rival changes a price. She cannot read four websites each morning.

Your research teammate reads the pages for her. It keeps a **snapshot** of each page. The next day it compares the new page with the snapshot and says what moved.

A rival page is messy. It has a cookie banner, a script and a tab that stays closed. This **page noise** must not reach the report. The text in the closed tab must.

## What you will have at the end

- A page reader that drops the noise and keeps the closed tab.
- A snapshot for each rival, saved only when the page changes.
- A report with the old text and the new text.
- A reply for any question outside the job.
- A Stagehand reader for the mock rival site, with a recorded file for replay.
- Snapshots kept through the document step, so a page that did not change is skipped.
- A router policy the product manager owns, and a cited answer.

## See it fail first

How does the product lead learn that a rival raised its price? Right now she does not. Nobody reads the pages, and a guess from memory is a stale price.

For example, Pulsedesk charged 49 dollars last week. Today it charges 79 dollars and adds a free plan. A guess still says 49.

## Start from the lab checkpoint

This lab starts from the finished grounded agent. The rival pages come from a small local website, so the lab never reads the open web.

```bash
bun run goto research-knowledge
```

Expect: a message that you are now on the research-knowledge checkpoint, with a list of things to do.

## Step 1: read the page without the noise

The reader cuts scripts, styles and the cookie banner. Then it strips the tags. Text inside a closed tab stays.

### apps/product-teammates/src/research.ts

```ts
const NOISE = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<div id="cookie-banner">[\s\S]*?<\/div>/gi,
];

// Keeps the words a person would read. A closed tab still counts, a cookie banner does not.
export function readPage(html: string): string {
  let text = html;
  for (const noise of NOISE) text = text.replace(noise, " ");
  text = text.replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}
```

## Step 2: compare the page with the last snapshot

The first look saves a snapshot. A page with the same hash is left alone. A changed page is saved and returned with its old text.

### apps/product-teammates/src/research.ts

```ts
export async function watchRival(rival: string, html: string): Promise<Watch> {
  const after = readPage(html);
  const last = await lastSnapshot(rival);
  if (last === undefined) {
    await saveSnapshot(rival, after);
    return { rival, status: "first", before: "", after };
  }
  const hash = createHash("sha256").update(after).digest("hex");
  if (hash === last.hash) return { rival, status: "unchanged", before: last.text, after };
  await saveSnapshot(rival, after);
  return { rival, status: "changed", before: last.text, after };
}
```

## Step 3: write the report

A first look, an unchanged page and a change each get one plain sentence. A change shows the old text and the new text.

### apps/product-teammates/src/research.ts

```ts
export function reportOn(watch: Watch): string {
  if (watch.status === "first") return `${watch.rival}: first look saved. It says: ${watch.after}`;
  if (watch.status === "unchanged") return `${watch.rival} did not change.`;
  return `${watch.rival} changed. Before: ${watch.before} Now: ${watch.after}`;
}
```

## Step 4: read the rival site with Stagehand

Stagehand is a tool that opens a browser and pulls out the facts you ask for. The mock rival site lives in `apps/product-teammates/mock-site`. Its pages have a history. In week 1 the Team plan costs 49 USD. In week 2 it costs 79 USD.

You have no model key in replay. So a recorded file plays back what Stagehand returned. A person built that file by hand from the mock pages, and the file says so. A live run needs a key and is a separate step.

### apps/product-teammates/src/capture.ts

```ts
export function priceMoves(before: string, after: string): PriceMove[] {
  const old = pricesIn(before);
  const moves: PriceMove[] = [];
  for (const [plan, to] of pricesIn(after)) {
    const from = old.get(plan);
    if (from !== undefined && from !== to) moves.push({ plan, from, to });
  }
  return moves;
}
```

## Step 5: keep a snapshot and skip a page that did not move

Each page becomes a small PDF. The document step reads it and keeps one row. A page with the same bytes is skipped. For example, week 3 looks like week 2, so no new snapshot is saved.

Write `capturePage` so it calls `ingestDocument` and reports `unchanged` when the file is skipped.

## Step 6: send trivia away with a policy

The product manager owns the word list in `apps/product-teammates/research/router-policy.json`. A question with none of the words gets the plain reply, and no page is read.

### apps/product-teammates/src/capture.ts

```ts
export function routeByPolicy(question: string, policy = loadPolicy()): AgentResult["route"] {
  const words: string[] = question.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const rule of policy.rules) {
    if (rule.words.some((word) => words.includes(word))) return rule.route;
  }
  return policy.otherwise;
}
```

## Step 7: cite every answer

The writer sends a claim. The claim must cite a snapshot it was shown. It may use only the numbers in that snapshot. A wrong price, a missing citation or an unseen snapshot is refused.

A strategy brief is a PDF. The `readStrategy` function reads it with xberg. The playbook for a full teardown is in `apps/product-teammates/research/competitor-teardown.skill.md`.

## Verify the lab

```bash
bun run verify research-knowledge
```

Expect: eleven green badges and the line "Every check passed."

## Try it yourself

Break the new price on purpose and watch the check catch it. The seed command puts the page back afterwards.

```bash
sed -i '' 's/79 dollars/89 dollars/' .data/competitors/pulsedesk-after.html && bun run verify research-knowledge
```

Expect: a red badge on the price check with the line "The report lacks the new price."

```bash
bun run seed
```

Expect: the line "Seeded 16 documents and the data files" and a clean verify next time.

## Stuck?

| You see                                 | Why                                               | Fix                                                                        |
| --------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| The report lacks the old price.         | watchRival does not keep the last snapshot text.  | In watchRival, return the saved text as before.                            |
| The cookie banner is in the report.     | readPage does not cut the banner.                 | In readPage, cut the banner, scripts and styles before you strip the tags. |
| The yearly price in the tab is missing. | readPage dropped the closed tab.                  | Strip tags only. Keep the text inside hidden sections.                     |
| The same page was saved twice.          | watchRival saves a snapshot when nothing changed. | Save a snapshot only when the hash differs from the last one.              |

If you are still stuck, start from a clean copy of this lab.

```bash
bun run goto research-knowledge
```

Expect: a message that you are now on the research-knowledge checkpoint, with a list of things to do.

## New words

- **snapshot**: A saved copy of a page as it looked on one day.
- **page noise**: Text on a page that is not the content, like a cookie banner or a script.
