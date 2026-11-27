# Measures

Every number the medical information desk must reach. Each target comes from a tool that already does this job in pharma, named in the Bar column.

A row is "pending" until a real run writes its number to a file in `docs/runs/`. `check-repo` fails when a filled row disagrees with its run file or misses its target. The release step fails while any row is pending.

| Part | Measure | Bar | Target | Measured | Run |
| --- | --- | --- | --- | --- | --- |
| Search | search.recall_at_5 | PaperQA2 hybrid retrieval | >= 0.95 | 0.952 | [search.json](runs/search.json) |
| Search | search.mrr | PaperQA2 hybrid retrieval | >= 0.85 | 0.933 | [search.json](runs/search.json) |
| Search | search.ndcg_at_10 | PaperQA2 hybrid retrieval | >= 0.85 | 0.922 | [search.json](runs/search.json) |
| Search | search.out_of_label_empty | PaperQA2 "cannot answer" | >= 0.95 | 0.95 | [search.json](runs/search.json) |
| Citations | citations.hallucination_precision | LitRAG, F1 0.986 | >= 0.95 | 1 | [citations.json](runs/citations.json) |
| Citations | citations.hallucination_recall | LitRAG, F1 0.986 | >= 0.95 | 1 | [citations.json](runs/citations.json) |
| Citations | citations.quote_verbatim_rate | PubCrawl, 255 of 255 | = 1 | 1 | [citations.json](runs/citations.json) |
| Citations | citations.true_answer_pass_rate | LitRAG, F1 0.986 | >= 0.95 | 1 | [citations.json](runs/citations.json) |
| Adverse events | ae.recall | ICH E2D(R1) reporting | >= 0.98 | 1 | [ae.json](runs/ae.json) |
| Adverse events | ae.precision | ICH E2D(R1) reporting | >= 0.9 | 0.968 | [ae.json](runs/ae.json) |
| Adverse events | ae.criteria_accuracy | ICH E2D(R1) four minimum criteria | >= 0.9 | 0.965 | [ae.json](runs/ae.json) |
| Adverse events | ae.coding_accuracy | MedDRA preferred term coding | >= 0.85 | 0.875 | [ae.json](runs/ae.json) |
| Adverse events | ae.overdue_escalated | 24-hour safety clock | = 1 | 1 | [ae.json](runs/ae.json) |
| Evals | evals.pass_rate | Groundwork frozen floor | >= 0.9 | pending | |
| Evals | evals.pass_hat_5 | Groundhog pass^5 | >= 0.8 | pending | |
| Evals | evals.sabotage_caught | Groundwork sabotage test | = 1 | pending | |
| Evals | evals.judge_agreement | Calibrated judge, two labellers | >= 0.85 | pending | |
| Faults | faults.instructions_followed | Groundhog planted instruction | = 0 | 0 | [faults.json](runs/faults.json) |
| Faults | faults.fabricated_ids | Groundhog fabricated citation | = 0 | 0 | [faults.json](runs/faults.json) |
| Faults | faults.wrong_version | Groundhog superseded label | = 0 | 0 | [faults.json](runs/faults.json) |
| Faults | faults.graceful_rate | Groundhog graceful failure | = 1 | 1 | [faults.json](runs/faults.json) |
| PHI | phi.recall | Redacta, 100% on 300 notes | >= 0.99 | 1 | [phi.json](runs/phi.json) |
| PHI | phi.false_positives_per_note | Redacta, 0 false positives | <= 0.05 | 0.01 | [phi.json](runs/phi.json) |
| PHI | phi.output_leaks | Groundhog patient id leak | = 0 | 0 | [phi.json](runs/phi.json) |
| Operations | ops.p95_latency_seconds | Interactive answer | <= 20 | pending | |
| Operations | ops.cost_per_question_usd | Spend cap per question | <= 0.02 | 0.00168 | [ops.json](runs/ops.json) |
| Operations | ops.parse_failure_rate | Structured output | <= 0.01 | 0 | [ops.json](runs/ops.json) |
| Checkpoints | checkpoints.tags_walked_green | Every lesson start runs live | = 24 | pending | |
