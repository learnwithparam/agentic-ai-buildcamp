import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { costOf, has, schemaIn, validate, within, yaml } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "05-price-the-outcome");
const file = (d: string) => yaml(d, "cost.yaml");
const valid = (d: string) => validate(schemaIn(STEP, "cost.schema.json"), file(d)).length === 0;

export default [
  {
    says: "cost.yaml exists and is valid YAML",
    test: (d) => has(d, "cost.yaml") && typeof file(d) === "object",
    tryNext: "create cost.yaml in this folder and check the indents line up",
  },
  {
    says: "cost.yaml matches cost.schema.json",
    test: valid,
    tryNext: "run bun run cost on your file; it lists each key that is missing or the wrong type",
  },
  {
    says: "the price is dated and has a source",
    test: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(file(d).price.checked_on)) && /^https:\/\//.test(file(d).price.source),
    tryNext: "set price.checked_on to the date you read the price (YYYY-MM-DD) and price.source to that page's URL",
  },
  {
    says: "failed runs are counted",
    test: (d) => file(d).runs.failed_per_outcome > 0,
    tryNext: "set runs.failed_per_outcome above 0; failed and killed runs still cost money, so start with 0.25",
  },
  {
    says: "your cost per outcome matches the recomputed one within 1%",
    test: (d) => valid(d) && within(file(d).cost_per_outcome_usd, costOf(file(d)).perOutcome, 0.01),
    tryNext: "run bun run cost on your file and copy its cost per outcome into cost_per_outcome_usd",
  },
  {
    says: "the cost is below the value of one outcome",
    test: (d) => valid(d) && costOf(file(d)).perOutcome < file(d).value_per_outcome_usd,
    tryNext: "use fewer calls, fewer tokens or a cheaper model; if none fit, the job is not worth an AI employee yet",
  },
] satisfies Rule[];
