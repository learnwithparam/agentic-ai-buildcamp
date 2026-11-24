---
name: hcp-labels
description: Look up what an approved medicine label says, through the medinfo MCP server, and answer with a citation for every fact. Use when asked about a medicine's dose, indication, contraindications, trial results, interactions or safety reporting, or to check a sentence against the label.
---

# Look up a medicine label

The medinfo MCP server answers for the doctor you signed in as. It knows their company and
country from the token, so it shows only the documents they may read. You never choose the
company or the country, and you never guess what a label says.

## Steps

1. Call `get_desk_rules`. Note `company`, `medicines`, `asker_country`, `approved_in_asker_country` and `today`.
2. If the question is about a medicine not in `medicines`, stop. Say this desk does not cover it and do not search.
3. If `approved_in_asker_country` is false, stop. Say the medicine is not approved in the asker's country and do not search.
4. Call `search_labels` once with the medicine, the patient detail and the country, for example
   `NeuroVex dose for a patient with moderate renal impairment, US`.
5. Use only sections whose `status` is in force on `today`. When two versions disagree, the newer one in force wins, and say which one you used.
6. Answer from the returned `text` only. Cite every fact as `[doc_id, section]`, for example `[neurovex-uspi-v1, 2.1]`.
7. If no section answers the question, say that the label does not cover it. Do not fill the gap from memory.

## Never

- Never answer a dose, an interaction or a contraindication without a citation.
- Never recommend a use the label does not list. Say it is outside the label.
- If the question mentions a patient who had a side effect, say it must be reported to the safety team, and give the reporting step from the label.

## If the server says "needs sign-in"

Run `/mcp`, choose `medinfo`, then `Authenticate`. Sign in on the Keycloak page with your seeded doctor.
