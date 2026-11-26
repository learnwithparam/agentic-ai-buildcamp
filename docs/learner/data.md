# The data behind the desk

Everything the agents read comes from `data/hcp`. It is a pinned copy of the
[learnwithparam/dataset](https://github.com/learnwithparam/dataset) repo, fictional from end to end:
two companies, Pharma A and Pharma B, their medicines CardioNex and NeuroVex, and the doctors they
serve. `data/hcp/dataset.lock.json` names the commit it came from and a hash for every file. A
changed file fails `npm run check` until the lock is synced again.

## The folders

| Folder | What it holds | Who reads it | Example |
| --- | --- | --- | --- |
| `labels` | The full text of each label, one Markdown file per version | `src/server/labels.ts`, for search and every label tool | `cardionex-uspi-2026-v2.md`, the US label, section 2.2 is the dose |
| `docs` | Short excerpts of the same documents, plus the 2024 draft that has no full label | `src/server/labels.ts`, when a document has no full label | `cardionex-draft-2024.md` |
| `pdf` | The labels printed as PDFs, the way a real company ships them | `scripts/rag-ingest.ts`, which reads their tags into pgvector (lesson 20) | `cardionex-jp-label-2025.pdf` |
| `content` | Approved claims, one sentence each, and two draft emails | `src/server/content/records.ts`, for the fact-checker (lesson 14) | `C-02,cardionex-uspi-v2,2.2,US,Start CardioNex at 20mg once daily...` |
| `crm` | Doctor profiles, consent, emails sent, call notes, sample requests | `src/server/content/records.ts`, for the outreach planner (lesson 14) | `HCP-1003` asked to stop all email |
| `events` | Events the desk reacts to, and the email one of them carries | `src/server/events/events.ts` (lesson 16) | `EVT-01`: label v3 comes into force and replaces v2 |
| `sql` | Weekly sales rows, one table per company, each in its own shape | `src/server/bi/load.ts`, into Postgres for insights (lesson 22) | `2026-09-07,NE-01,brand_cardionex,142,38,...` |
| `evals` | The test cases, one YAML file per agent | `scripts/hcp-cases.ts`, for every dataset run. See [Eval cases](evals.md) | `medinfo.yaml`, case `[POSITIVE-01]` |
| `gold` | Questions with the sections that answer them, graded by hand. Claims, each with a quote that does or does not support it | `scripts/search-eval.ts`, which measures the search (lesson 20) | `r-059`: "How long do I have to wait when switching?", after a turn about ACE inhibitors |
| `spl` | The US labels as SPL XML, the format the FDA publishes. Each has a set id, a version and coded sections | `npm run ae:measure` scores the safety extraction on the messages | `cardionex-uspi-2026-v2.xml` |
| `history` | Every version of each label, its dates and what changed, in DailyMed's set-id history shape | `npm run ae:measure` scores the safety extraction on the messages | `cardionex-uspi.json`: v2 added a warning |
| `safety` | Adverse event messages marked with the four reporting criteria. A made-up MedDRA-style dictionary. Notes with planted patient details, and where they are | `npm run ae:measure` scores the safety extraction on the messages | `ae-001`: swollen lips, no product named |

## How a label file works

Each label starts with front matter, then one heading per section:

```markdown
---
doc_id: cardionex-uspi-v2
tenant_id: pharma_a
brand_id: brand_cardionex
status: active
effective_date: 2026-09-15
country: US
---

# CARDIONEX (cardionexib) Prescribing Information, September 2026 Revision

## 0.0 Boxed Warning and Contraindications
```

- **`doc_id`** is what a citation names: `[cardionex-uspi-v2, 2.2]`.
- **`tenant_id`** is the company. Search never returns another company's label.
- **`status` and `effective_date`** decide whether a label is in force today. `statusOn` in
  `src/server/labels.ts` reads both. A label approved for a date still to come is not in force
  yet.
- **`country`** is where the label applies. The desk answers from the asker's country, and marks
  any other country's label as such.

## Why there are versions and drafts

A real desk holds old and future labels next to the current one. It must never quote the wrong one,
so the data holds them too:

- **`cardionex-uspi-v1`** is superseded by v2.
- **`cardionex-uspi-v2`** is in force today.
- **`cardionex-uspi-v3`** is approved, but starts on 2027-03-01. `EVT-01` is the event that brings
  it into force.
- **`cardionex-draft-2024`** was never approved. Citing it fails the citation check (lesson 21).

Ask the desk "Which CardioNex label is in force in the US?". It calls `label_versions`, which lists
each version with its status and why.

## Test it

From the terminal:

```bash
npm run demo:check                                  # the demo chats, through the real sign-in and model
npm run ae:measure                                  # adverse event recall, criteria and coding, into docs/runs/ae.json
npm run medinfo -- ask "What is the CardioNex dose for eGFR 24?"   # after npm run medinfo -- login (lesson 19)
docker exec medinfo-platform-postgres-1 psql -U postgres -d medinfo -c "select count(*) from label_chunks"
```

In Langfuse:

- **Datasets** holds one item per eval case, seeded by `npm run dataset:seed`.
- **Experiments** holds one run per `npm run dataset:run`, with a score per item.
- **Tracing** holds one trace per chat turn. Its `search-labels` span shows the query and the
  sections it found, with their scores.
