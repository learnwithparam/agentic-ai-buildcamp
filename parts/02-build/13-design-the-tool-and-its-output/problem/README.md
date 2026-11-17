# Design the tool and its output

## The problem

A tool called `invoices` with the note "Gets invoices" makes the model guess when to call it. A tool that hands back a
friendly sentence makes your code guess what it meant.

So name the tool for its job. Say when to use it and when not to. Hand back fields that your code can read.

For example, `look_up_invoice` takes `INV-2041` and hands back `total_usd: 1910` and `status: open`.

```mermaid
flowchart LR
  Model[Model] -->|invoice_id| Tool[look_up_invoice]
  Tool -->|invoice_id, total_usd, status| Code[Your code reads the fields]
  Tool -.->|error plus a fix| Model
```

Notice: The tool returns fields your code can read. A bad call returns an error that says how to fix it.

## Your challenge

Fill in `tool.yaml` for one tool of your employee:

1. `name`: a verb and a thing, in snake case, such as `look_up_invoice`.
2. `description`: it must say "Use when" and "Do not use".
3. `input`: each field has a `type` and a `description`.
4. `output_schema`: an object. Every field is `required`. Use an `enum` for any choice, such as a status.
5. `example_output`: one real answer that fits your schema.
6. `error_example`: an `error` that says what went wrong, and a `fix` that says what to try next.

## Done when

- The name says the job. The description says when to use it and when not.
- The output has fixed fields, and the example fits them.
- A mistake returns an error with a fix.

```bash
bun run verify design-the-tool-and-its-output
```

Expect: `Done. All 6 rules pass.`

The freight sample is in [solution/tool.yaml](../solution/tool.yaml).

## If you get stuck

| What you see                                            | Fix                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `FAIL the example output fits the output schema`        | Make every required field appear in the example, with the right type.   |
| `FAIL the description says when to use it and when not` | Add a sentence that starts "Use when" and one that starts "Do not use". |

## Words you will use

- **Schema**: a list of fields and their types that an answer must follow.
- **Enum**: a short list of allowed words, such as open, paid or disputed.
- **Structured output**: an answer in fixed fields, not a sentence.
