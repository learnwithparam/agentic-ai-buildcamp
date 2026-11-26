# Eval cases

The test cases live in `data/hcp/evals`, one file per agent: `medinfo.yaml`, `fact-check.yaml`,
`outreach.yaml`, `a2a.yaml`, `events.yaml`, `autonomy.yaml` and `insights.yaml`. Each file is
promptfoo's standard YAML config: `providers`, `prompts`, `defaultTest` and `tests`. Its baseline
provider is a bare model with no agent, so the cases start red.

The course runs the same cases against the real agent, with its own runner. Langfuse holds the
scores.

## Read one case

```yaml
- description: "[POSITIVE-01] Footnote * trap: Normal renal function + clarithromycin caps dose at 5mg"
  metadata:
    slice: "footnote"
    chapter: "01"
    riskTier: "answer"
    split: "train"
    expectedBehavior: "reply"
    idealAnswer: "No. Clarithromycin is a strong CYP3A4 inhibitor, so CardioNex must not exceed 5mg once daily..."
  vars:
    query: "My HFrEF patient has normal kidney function (eGFR 85) and is taking clarithromycin. Can I titrate CardioNex to 40mg?"
  assert:
    - type: contains
      value: "5mg"
    - type: llm-rubric
      value: "Explains clearly that because clarithromycin is a strong CYP3A4 inhibitor..."
    - type: regex
      value: "\\[cardionex-uspi-v2,\\s*2\\.2"
```

- **`description`** starts with the case id in brackets. The id names the case everywhere: in
  Langfuse, on the scoreboard and in a failed run's output.
- **`vars`** are the inputs. `query` is what the doctor asks. `tenantId`, `brandId` and `country`
  come from the file's `defaultTest` unless the case sets its own.
- **`metadata.slice`** groups cases by what they test. Each slice is one column on
  `docs/scoreboard.md`.
- **`metadata.chapter`** is the lesson that first makes the case pass.
- **`metadata.riskTier`** is the tier the router must choose: `answer`, `review`, `safety` or
  `stop`.
- **`metadata.split`** is `train` or `holdout`. Tune prompts on `train` cases only. The
  `holdout` cases then show whether a change works on cases it was not tuned on (lesson 05).
- **`metadata.expectedBehavior`** is `reply`, `defer_question` or `ask_follow_up`.
- **`metadata.idealAnswer`** is a model answer. The faithfulness judge compares against it.

## Assert types

Every assert must hold for the case to pass its text checks.

| Type | Passes when |
| --- | --- |
| `contains` | The answer contains the value, after bold marks and spacing are made the same (`normalizeAnswer` in `scripts/hcp-cases.ts`) |
| `not-contains` | The answer does not contain the value. Used for leaks, such as another company's doctor's email |
| `regex` | The answer matches the pattern. Used for citations, whose spacing varies |
| `not-regex` | The answer does not match the pattern |
| `llm-rubric` | A model grades the answer against the sentence. promptfoo runs it. The course's runner leaves it out, and the faithfulness judge covers those slices instead |

## From a case to a score

1. `npm run dataset:seed` turns each case into one Langfuse dataset item (`scripts/hcp-cases.ts`).
   The item's input is the question and the company. Its expected output is the ideal answer, the
   behavior and the text checks. Its metadata keeps the id, slice, chapter and tier.
2. `npm run dataset:run` runs the real agent on every item, as one experiment, and scores each
   answer:
   - **`behavior_match`**: did the agent reply, defer or ask, as the case expects.
   - **`label_checks`**: did every text check pass.
   - **`faithfulness`**: does the answer say only what its sources say, on the judged slices.
   - **`risk_tier`**: did the router choose the case's tier, on the tiered slices.
3. The run adds one row to `docs/scoreboard.md` and prints every miss with its answer.

## Read a red row

Open the experiment in Langfuse under **Datasets**, then the run. Sort by the red score and open the
item's trace. Then ask, in this order:

- **Is the case right?** New data can answer a question a case says has no answer.
- **Is the evaluator right?** A marker in a correct answer can read as a refusal.
- **Is the agent wrong?** Only then change the prompt, a tool or the code. Then run the slice again.
