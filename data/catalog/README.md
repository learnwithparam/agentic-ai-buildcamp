# The data card

Everything here is invented. No drug, doctor, company or number is real. The seed uses a fixed number. So every learner gets the same files and the same golden answers.

Run it with `bun run seed`.

Expect: a line that says how many documents were seeded, and a `.data/` folder.

## Datasets

| Dataset              | What it holds                                                                                                                               | Pattern built in                                                              | Used by                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| Labels and letters   | Five brands in four countries, with old, current, future and expired versions                                                               | A dose that changed between versions, and a brand not approved in one country | documents-freshness, grounded-answer |
| Odd documents        | A scan with no text, a two column study with footnotes, a study with a results table, a safety letter, an FAQ and a PDF with a hidden order | Each one breaks reading in a different way                                    | documents-freshness, grounded-answer |
| Inbound messages     | Medical questions, an adverse event inside a friendly email, an off-label ask and trivia                                                    | Each message has one right route                                              | intent-routing                       |
| Weekly prescriptions | Eight territories and three brands for a year                                                                                               | A launch ramp, a winter peak, a spring peak and one supply dip                | analytics-mcp                        |
| Monthly dispenses    | Four regions and two brands, with other column names                                                                                        | A summer dip and a price rise in July                                         | analytics-mcp                        |
| Prescribers          | Forty invented doctors with names and emails                                                                                                | Personal data that must never reach a prompt                                  | analytics-mcp, guardrails-workers    |
| People and grants    | Seven people with roles, countries and links to territories and workspaces                                                                  | Role, attribute and two step relationship rules                               | access-control                       |
| Product funnel       | Twenty weeks for three plans, and the same weeks by channel                                                                                 | One churn spike and one activation dip that sits in the paid channel          | product-intelligence-bi              |
| Rival pages          | Four rivals with four weekly pages each                                                                                                     | A price rise, a renamed plan, a removed feature and no change                 | research-knowledge                   |
| Workspace memos      | One memo in a private workspace                                                                                                             | A fact only its owners may read                                               | tenancy-and-memory                   |

## Golden cases

Each track has 24 cases. Every route has at least three cases. A few lab cases sit outside the 24 in `HCP_LAB_CASES` and `MISSION_CONTROL_LAB_CASES`. The expected answer is data computed from the files above, never from a model. The tests in `tests/catalog.test.ts` check the spread. They count brands, countries, document types, people and kinds of case.
