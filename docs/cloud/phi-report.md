# PHI part: report

Branch `cloud/phi`, from `origin/search-hybrid`. No PR, nothing merged. `docs/measures.md` and `docs/runs/*.json` are untouched, and `docs/runs/phi.json` does not exist yet: the orchestrator writes it.

## What I built

A pseudonymiser in `src/server/phi.ts`, a model step in `src/server/phi.model.ts`, a vault wired into the agent, a leak check, and the measure script.

- **Rules** (`findSpans`): email, national ID (SSN and 5 other shapes, plus "insurance number" style cues), record numbers (cue words and a bare `AB-1234` shape), dates of birth (a cue such as `DOB` or `born`, or a full date with no event word before it and a year of 2024 or earlier), phones (separator shape, 9 to 15 digits, and a `+`, `(`, leading 0, US shape or a cue word), addresses (a run of capitalised words and numbers with a house number and a postcode; a CJK pattern), names (after a title, `patient`, `initials`, a relative word, `name is/as`, or next to another found identifier such as `Hanna Keller, DOB ...`). A clinic's street with no postcode and a sender's own email (it starts with the surname of a `Dr X` in the text) are left alone.
- **Model step** (`modelSpanFinder`): one `json_schema` call through `modelClient()`. It gets the text after the rules, so what the rules found is already a placeholder. It returns words, not offsets. `findOnly` keeps a word only when it is a substring of the text outside placeholders, is not the whole message, and has a known type. It runs only when the scrubbed text is 20 characters or longer. It is not traced, on purpose: a trace would store the words it exists to find.
- **Vault** (`PhiVault`): `[PATIENT_1]`, `[DOB_1]`, `[ADDRESS_1]`, `[MRN_1]`, `[PHONE_1]`, `[EMAIL_1]`, `[ID_1]`, stable per conversation (same words in any case or spacing give the same placeholder). `hideKnown` replaces an identifier seen before wherever it shows up again, and a name's parts of 4 letters or more (a surname alone in turn 2, or `Papadakis Medical` after `Ms Eleni Papadakis`). `restore` and `restoreDeep` put the words back. The map lives in the server's memory only, per thread id, capped at 5000 threads.
- **Wiring** (`src/server/medinfo-agent.ts`, `src/server/index.ts`, both small): `runTurn` pseudonymises the new human messages with the thread's vault before the trace input, the router or the checkpoint see them, and wraps `emit` and `readThread` so the doctor reads their own words. `index.ts` passes the model step unless `PHI_MODEL_FINDER=off`. Scripts (`runMedinfoTurn`) pass none. `REMOVED` now also matches the placeholders, so the safety reply still knows an identifier was in the message.
- **`scrubPhi`** keeps its signature and its old labels (`[record number removed]`), so `tiers.test.ts`, `sweep.live.ts` and the call sites in routes, events and the sweep work unchanged. It now uses the same rules (rules only, no model, no map), so those call sites also lose names, birth dates and addresses.
- **Leak check** (`leakedFrom`): every original the vault holds, found word for word in the model text, the trace input or the checkpoint bytes.
- **Measure** (`scripts/phi-eval.ts`, `npm run phi:measure`): see below.
- **Doc**: two lines in `docs/learner/13-durable-state-and-review.md` and one bullet under "Where to go next" that names `phi:measure` (check-repo needs a doc to show it). `check:pages` pieces that run here pass (plain English, lesson shape, glossary). `mmdc` is not installed, so the mermaid step did not run; I changed no diagram.

## Files

New: `src/server/phi.model.ts`, `src/server/phi.test.ts`, `src/server/phi.leak.test.ts`, `src/server/phi.live.ts`, `scripts/phi-eval.ts`, `scripts/phi-eval.test.ts`, `docs/cloud/phi-report.md`.
Changed: `src/server/phi.ts` (rewritten), `src/server/medinfo-agent.ts`, `src/server/index.ts`, `package.json` (one script), `docs/learner/13-durable-state-and-review.md`.

## Tests, and whether I saw each fail first

I broke the code with a one-line change, ran the test file, saw red, and restored it. 22 breaks, all red after I added four assertions (the first run left 5 green: event-word handling, stable placeholders, the house-number rule, hiding a known name before the rules, and `--fake` writing the real run file; each now has an assertion and went red on the second try).

| Test | Broken by | Result |
| --- | --- | --- |
| names after a title, cue, relative or beside an identifier | name rule off | red |
| dates of birth in each form | dob rule off | red |
| addresses need a house number and a postcode | address rule off; house-number check removed | red, red |
| record numbers, phones, emails, ID numbers | each rule off, one at a time (mrn, phone, email, national ID) | red x4 |
| sender's own email is left | email rule off | red |
| clinical numbers and event dates survive | event-word check removed | red |
| same placeholder across turns, new one gets the next number | stability check removed; pre-hide of known words removed | red, red |
| restore, restoreDeep | `restore` returns the text | red |
| one vault per conversation | one shared counter | red |
| the model's words must be in the text | substring check removed | red |
| the model step sees only what the rules left | same break | red |
| short message skips the model step | length check removed | red |
| leak check finds an original in a payload | leak check blind | red |
| `scrubPhi` labels | label changed | red |
| rules alone reach the bar on the 100 notes | national ID rule off | red |
| leak test, Postgres checkpointer and trace (`phi.leak.test.ts`) | `restore` off; scrub skipped in the agent; model step skipped in the agent | red x3 |
| measure arithmetic (`phi-eval.test.ts`) | recall divisor off by one; false positives not counted; `--fake` default path | red x3 |

`phi.leak.test.ts` runs the real agent with the real `PostgresSaver` and real tracing on a message the lesson 10 door refuses, so no model is called. It checks that 8 identifiers (name, birth date, record number, phone, address, email, ID number, and a name only the model step finds) are in neither the checkpoint (every table of the schema, bytea columns decoded) nor the trace attributes, that placeholders repeat in turn 2, that the doctor's stream and `readThread` hold their own words, and that no placeholder reaches them.

Full suite: `npx tsx --test 'scripts/**/*.test.ts' 'src/**/*.test.ts'` gives 267 pass, 15 fail. The 15 are environment, not this change (the same tests failed on the branch before my change; before I made the test database and insights logins there were 99 failures):

- need OpenFGA (`FGA_API_TOKEN is not set`): `permissions.test.ts`, `inbox.test.ts`, `mcp.test.ts`, `content.test.ts`, `a2a/a2a.test.ts`.
- `rag.test.ts`: the installed pgvector has no `hnsw.iterative_scan` (needs 0.8), and one test expects no index.
- `bi.test.ts`: "the app's own role reads none of the published rows" needs the app login to be a non-superuser, and mine is a superuser.

I could not run OpenFGA. I downloaded the release binary, and the session's auto mode refused to start it, so I stopped there.

## Not run

- `src/server/phi.live.ts`: needs the model gateway. It checks that the real finder names 3 patients the rules miss (words in the text), returns nothing for a note with only a doctor, clinic, medicine and numbers, and is never sent what the rules took. I could not run it, so I have not seen it pass or fail.
- Docker, Keycloak, Langfuse, gateway: not available. Tests that need them were skipped or fail as listed.
- `npm run check:pages` mermaid step (`mmdc` missing).

## Measure

```bash
npm run phi:measure
```

It needs `GATEWAY_KEY_EVAL_RUNNER`. It runs each note twice (`rules`, then `rules_model`) and writes `docs/runs/phi.json` with `measures` (`phi.recall`, `phi.false_positives_per_note`, `phi.output_leaks`, from `rules_model`), both configs with recall per type, and lists of misses, false positives and leaks. `npm run phi:measure -- --fake` uses an oracle that returns each note's gold spans instead of a model, so it proves the arithmetic. It writes no file unless `--out` is given, so it cannot become the measured file. It is a function, not a model client, so `no-fake-model.test.ts` still passes.

What the measure counts:
- recall: a gold span counts as hidden when its words, and every word of 4 letters or more in it, are gone from the text the model reads (a leading title is not part of a name).
- false positives: a replaced word that contains no gold span and is inside none.
- output_leaks: an identifier the pseudonymiser replaced that is still in the model text, the trace input or the checkpoint bytes (serialised with the checkpointer's own serializer). It is separate from recall: a name the pseudonymiser missed is a recall miss, not a leak, because it is not in the vault.

## Read this before you trust the numbers

- **The rules were tuned on the 100 notes.** Rules alone score recall 1.0, 0 false positives and 0 leaks on them (the test `on the 100 marked notes the rules alone reach the bar` asserts the bar). That is an in-sample number. I checked wordings I wrote myself (`notes written after the rules, in new wordings`, 6 notes) and fixed what broke, but that is small. Measure on notes the rules have not seen before you quote the number. The brief says 300 notes; the file has 100 notes and 201 spans.
- The model step is one more place the text goes. It sees only what the rules left, so a name the rules missed does reach the gateway. This is the design the brief asked for, and the only way to find a name the rules cannot. If you do not want the gateway to log that, switch it off with `PHI_MODEL_FINDER=off` and accept rules alone.
- The model step adds one model call per human message of 20 characters or more. It will show in ops cost and latency.

## Left out

- **The vault is in memory.** After a restart the map is gone: replies show `[PATIENT_1]` to the doctor, and a new name in the same thread would start again at `[PATIENT_1]`, which collides with the one in the checkpoint. Persisting it needs a table (`014_*`, since 012 and 013 are taken) and encryption of the originals, and I did not want to store identifiers in the app database unencrypted. Not built.
- The reviewer inbox shows placeholders, not the doctor's words. Reviewers cannot see who the patient is. That is the existing design (the inbox got scrubbed text before), but it is now less readable.
- Events, the sweep, the fact-checker, the outreach planner and the A2A handoff still call `scrubPhi`: rules only, labels, no map, no model.
- No data was needed, so there is no `docs/cloud/phi-dataset.md`.
- Dates of birth with only a year ("born in 1948") are not hidden: the gold marks them as not an identifier.
- The doctor's own name, clinic and clinic address are not hidden (the gold does not mark them), except when a `Dr` name is next to another found identifier.
- No Claude-Session trailer in the commit, as the brief says.
