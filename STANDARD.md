# The workshop standard

Every learnwithparam course repo starts from this template and follows these rules. Each rule is a check:
`bun run check` runs them all, CI runs it on every push, and a rule with no check does not count.
The research behind each rule is in the curriculum repo under `workshop-standard/research/`.

## Shape

```
README.md                    run the finished system first, then how the course works
src/workshop.ts              the one list of modules and labs, with tags and prerequisites
src/{glossary,stuck,pictures}.ts   course data, one source each
packages/core/src/           the shared agent code; taught code sits in region markers
apps/hcp-showcase/           the instructor track, modules 00 to 10
apps/product-teammates/      the participant track, labs 01 to 04
checks/<slug>.ts             what one module or lab must do, with a Try next line each
content/<slug>.ts            the picture, glossary words, stuck row and planted breaks
tests/promises/<stem>.test.ts  one promise test for each module and lab
docs/{modules,labs}/<stem>.md  the learner pages, from the manifest
data/catalog/                the seeded synthetic data and the golden sets
design-pack/                 templates for the no-code path
config/models.ts             the only file that names a model
case-studies/                the two case studies, never changed by the rework
```

Main holds the finished course. `bun run checkpoints --tag` builds a tag for each unit by swapping the
unit's regions, and every later unit's regions, for their stubs. The release job proves each tag: it
type-checks, the verify before it passes, and its own verify fails.

## Rules and the check behind each

| Rule                                                                                                                                                                                                                            | Check             | Learned from                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| No Makefile. Commands are Bun or `uv run` scripts.                                                                                                                                                                              | `check.ts` 1      | user, 12 Nov 2026                                    |
| A step is named verb-thing and the learner types that name: `bun run verify <step-name>`. Never a number.                                                                                                                       | `check.ts` 2, 3   | epicshop issue #184, numbered steps break on reorder |
| Plain English: no em dash, no hype word, no week, day or hour in content.                                                                                                                                                       | `check.ts` 2      | RESEARCH.md                                          |
| Every part README has a Mermaid diagram and a Walkthrough section with its commands.                                                                                                                                            | `check.ts` 3      | RESEARCH.md, user 12 Nov 2026                        |
| The root README shows the finished system as a screenshot and a Mermaid diagram; the orientation shows a screenshot.                                                                                                            | `check.ts` 2b     | user 12 Nov 2026                                     |
| Every step shows a picture: a screenshot or a Mermaid diagram.                                                                                                                                                                  | `check.ts` 3      | user 12 Nov 2026                                     |
| Every image a page names exists.                                                                                                                                                                                                | `check.ts` 2b     | user 12 Nov 2026                                     |
| Every step README has: The problem, Your challenge, Done when, If you get stuck, Words you will use.                                                                                                                            | `check.ts` 3      | epicshop, Carpentries                                |
| A step takes 5 to 30 minutes and its README stays under 600 words. Split, never squeeze.                                                                                                                                        | `check.ts` 3      | epicshop step sizes                                  |
| A step whose result is on screen ships `images/expected.png` and shows it.                                                                                                                                                      | `check.ts` 3      | Langfuse workshop learner docs                       |
| The check fails on the starter, fails on every wrong answer, and passes on the solution.                                                                                                                                        | `verify.ts --all` | Rustlings, freeCodeCamp #70626 and #67904            |
| Every failing rule prints a try-next sentence.                                                                                                                                                                                  | `verify.ts --all` | Exercism, mcp-fundamentals                           |
| Pass, fail and error exit 0, 1 and 2. Progress is recomputed from the checks every run.                                                                                                                                         | `verify.ts`       | GitHub Skills stuck learners, Oct 2026               |
| `bun run verify --report` writes `verify-report.json` for cohort grading.                                                                                                                                                       | `verify.ts`       | Exercism results.json, GitHub Classroom              |
| The README runs the finished system before any concept section.                                                                                                                                                                 | `check.ts` 4      | Decoding AI courses, llm-twin #25                    |
| Every bash block is followed by an `Expect:` line.                                                                                                                                                                              | `check.ts` 4      | live-labs walkthrough                                |
| Model ids live only in `config/models`. Versions are pinned exactly.                                                                                                                                                            | `check.ts` 5      | anthropics/courses #71, philoagents #43              |
| Every failure message a learner can see is in `00-orientation/troubleshooting.md`.                                                                                                                                              | `check.ts` 5      | Langfuse workshop #30, philoagents #31               |
| Every schedule covers every part, and its minutes add up.                                                                                                                                                                       | `check.ts` 6      | RESEARCH.md                                          |
| Every page passes the text audit at 1280 px and 375 px: no ellipsis, no clipped text, no raw ids, verb-plus-object buttons, guiding errors and empty states, short tooltips, labelled inputs, no model or cost on public pages. | `text-audit`      | UI audit, 13 Nov 2026                                |
| U14: no sideways scroll at 375 px. `document.documentElement.scrollWidth` is at most the window width.                                                                                                                          | `text-audit` 10   | UI audit, 13 Nov 2026                                |

## Readable code

Learners read our code before they write their own, so every file reads like plain English, in every
language. `bun run readable` checks it, and `bun run check` runs it first.

- **Names are whole words** that say what the thing holds or does: `invoice`, `overdueInvoices`,
  `sendReminder`. Never `d`, `r`, `x`, `ctx`, `res`, `fn` or `msg`. Only `i`, `j`, `id`, `ok`, `db`,
  `fs`, `os`, `io` and `ui` may be short.
- **One idea per line.** A chain of more than three calls becomes named steps. Never a ternary inside a
  ternary; use `if` and `else`.
- **Short and flat.** A function does one job in 40 lines or fewer, takes at most 4 inputs, and stays
  shallow (cognitive complexity 10 or less).
- **Lines are 100 characters or fewer**, formatted by the language's own tool, never by hand: Biome for
  TypeScript and JavaScript (`bun run format`), ruff for Python (`uvx ruff format`), and `terraform fmt`,
  `gofmt` or `shfmt` for those languages.
- **A comment says why**, in a plain sentence. The code already says what.
- **Wire names stay as the contract spells them.** A property that crosses HTTP or lands in a file, such
  as `job_id` or `cost_usd`, keeps its snake_case name, so `biome.json` allows snake_case for object and
  type properties. Every variable, function and parameter is still camelCase.

```typescript
// Hard to read
const due = (d: Inv[]) => d.filter((x) => x.s === "open" && x.dt < now()).map((x) => x.id);

// Reads like English
function overdueInvoiceIds(invoices: Invoice[]): string[] {
  const today = new Date();
  const overdue = invoices.filter(
    (invoice) => invoice.status === "open" && invoice.dueDate < today,
  );
  return overdue.map((invoice) => invoice.id);
}
```

## Plain English

Learners read every page in their second or third language. So each page uses short sentences, everyday words and a real example.

- One idea per sentence, 25 words at most.
- Everyday words: "use", not "utilize". "For example", not "e.g.".
- Every teaching page (the root README, each part README, each step's problem README) shows one case with "For example".
- Reading grade 8 or lower. A course for people who do not code sets `"plainEnglish": { "grade": 6 }` in package.json.

Hard to read:

> Utilize the verifier subsequent to modifying the configuration in order to ascertain correctness.

Easy to read:

> Change the config. Then run `bun run verify`. For example, after you add a rule, the check tells you if it passes.

## Checks test behaviour

A check runs the learner's command or calls their endpoint and judges the answer. It never imports their
functions, so any language or framework passes. Open-ended courses publish a small CLI or HTTP contract and
check scenarios against it.

## Run it

```bash
bun run check
```

Expect: `The repo meets the standard` and `Every check rejects its starter and wrong answers, and passes its solution.`

## Text audit

`bun run text-audit` opens every page in a real browser, at 1280 px and 375 px wide, and runs 10 checks.
`bun run check` runs it.

1. No ellipsis in visible text (U1).
2. No text clipped by CSS ellipsis or line-clamp (U2).
3. Buttons say a verb plus an object, in 2 to 5 words (U3, U4).
4. Errors say what happened and what to do next (U5, U6).
5. Empty states guide, with a `data-empty-state` message and a link, button or command (U7).
6. No raw ids, snake_case codes, `undefined` or `null` on screen (U8).
7. No model name, token count, host or cost on a public page (U9).
8. Tooltips are 15 words or fewer (U12).
9. Every input has a visible label (U13).
10. **U14: no sideways scroll at 375 px.**

Staff pages carry `data-audience="staff"` on `<body>`. Only check 7 skips them.
