# What each promise is tested by

Each row is a promise from [case study 1](../case-studies/enterprise-agentic-hcp-system.md). The chapter is where the build makes the promise true. The cases are in `data/hcp/evals/`, copied from the dataset repo.

`npm run check` fails when a row has no case, names a case that does not exist, or a case is in no row.

| Promise | Chapter | Cases |
|---|---|---|
| Answers use only approved files and name the source | 01 | POSITIVE-01, POSITIVE-02, POSITIVE-03, MULTITURN-01 |
| A drafted reply waits for a human reviewer | 01 | REVIEW-01 |
| Knows when to stop: no guess when there is no approved answer | 03 | NEGATIVE-01, NEGATIVE-02, NEGATIVE-03, PUSHBACK-01, AMBIGUOUS-01 |
| Facts come from the label in force today | 07 | STALENESS-01, STALENESS-02, STALENESS-03, FUTURE-01 |
| An instruction hidden in a document is ignored | 07 | INJECTION-01, INJECTION-02 |
| Answers that join two files stay faithful to both | 09 | POSITIVE-04 |
| Questions outside medical information are turned away | 10 | GUARDRAIL-01 |
| A doctor sees only content approved for their country | 11 | COUNTRY-01, COUNTRY-02, COUNTRY-03, COUNTRY-04 |
| One company never sees another company's data | 11 | TENANCY-01, TENANCY-02, TENANCY-03, TENANCY-04 |
| A side effect report goes to a human within 24 hours, with no patient details | 13 | SAFETY-01, PV-01 |
| One shared profile per doctor, and a rep approves each outreach step | 14 | OUTREACH-01, OUTREACH-02, OUTREACH-03, OUTREACH-04, OUTREACH-05, OUTREACH-06 |
| Every email sentence matches an approved claim, or a human sees it | 14 | FACT-01, FACT-02, FACT-03, FACT-04, FACT-05, FACT-06 |
| People make the risky choices: each risk tier goes to the right place, on every medicine | 13 | ROUTING-01, ROUTING-02, ROUTING-03, ROUTING-04, ROUTING-05, ROUTING-06, ROUTING-07 |
| One agent hands work to another under a contract, and a flagged hand-off asks a human | 15 | A2A-01, A2A-02, A2A-03, A2A-04, A2A-05 |
| Each new email, note, draft or label starts the right work once, inside one company | 16 | EVENT-01, EVENT-02, EVENT-03, EVENT-04, EVENT-05, EVENT-06 |
| The system works alone only on plain answers, inside a budget, with an off switch | 17 | AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05 |
| A doctor's own words find the right section of the full label PDF, with no word lost from the PDF | 20 | RAG-01, RAG-02, RAG-03 |
