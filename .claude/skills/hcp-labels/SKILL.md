---
name: hcp-labels
description: Look up what an approved medicine label says, through the medinfo MCP server, and answer with a citation for every fact. Use when asked about a medicine's dose, indication, contraindications, trial results, interactions or safety reporting, or to check a sentence against the label.
---

# Look up a medicine label

The medinfo MCP server answers for the doctor you signed in as. It knows their company and
country from the token, so it shows only the documents they may read. You never choose the
company or the country, and you never guess what a label says.

## Steps

1. Read the server's instructions: they name the company, its medicines, the asker's country, whether a label is in force there, and today's date.
2. If the question is about a medicine the instructions do not name, stop. Say this desk does not cover it and do not search.
3. If no label is in force in the asker's country, stop. Say the medicine is not approved there and do not search.
4. Call `search_labels` once, in the doctor's own words, with the medicine, the patient detail and the country, for example
   `NeuroVex dose for a patient with moderate renal impairment, US`.
5. If you need more, take one more step with the lookups: `read_section`, `label_versions`, `approval_status`, `check_interaction` or `trial_results`.
6. Use only sections whose `status` is `active`. When two versions disagree, the one in force wins, and say which one you used.
7. Answer from the returned `text` only. Cite every fact as `[doc_id, section]`, like the example in the instructions.
8. If no section answers the question, say that the label does not cover it. Do not fill the gap from memory.

## Never

- Never answer a dose, an interaction or a contraindication without a citation.
- Never recommend a use the label does not list. Say it is outside the label.
- If the question mentions a patient who had a side effect, say it must be reported to the safety team, and give the reporting step from the label.

## If the server says "needs sign-in"

Run `/mcp`, choose `medinfo`, then `Authenticate`. Sign in on the Keycloak page with your seeded doctor.
