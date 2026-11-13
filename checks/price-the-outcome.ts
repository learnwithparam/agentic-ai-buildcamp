import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { type CostFile, costOf, hasFile, readYaml, schemaIn, validate, within } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "05-price-the-outcome");
const costFile = (folder: string) => readYaml<CostFile>(folder, "cost.yaml");

function matchesSchema(folder: string): boolean {
  const schema = schemaIn(STEP, "cost.schema.json");
  return validate(schema, costFile(folder)).length === 0;
}

export default [
  {
    says: "cost.yaml exists and is valid YAML",
    test: (folder) => hasFile(folder, "cost.yaml") && typeof costFile(folder) === "object",
    tryNext: "create cost.yaml in this folder and check the indents line up",
  },
  {
    says: "cost.yaml matches cost.schema.json",
    test: matchesSchema,
    tryNext: "run bun run cost on your file; it lists each key that is missing or the wrong type",
  },
  {
    says: "the price is dated and has a source",
    test: (folder) => {
      const { price } = costFile(folder);
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(String(price.checked_on)) && /^https:\/\//.test(price.source)
      );
    },
    tryNext:
      "set price.checked_on to the date you read the price (YYYY-MM-DD) " +
      "and price.source to that page's URL",
  },
  {
    says: "failed runs are counted",
    test: (folder) => costFile(folder).runs.failed_per_outcome > 0,
    tryNext:
      "set runs.failed_per_outcome above 0; failed and killed runs still cost money, " +
      "so start with 0.25",
  },
  {
    says: "your cost per outcome matches the recomputed one within 1%",
    test: (folder) => {
      if (!matchesSchema(folder)) return false;
      const cost = costFile(folder);
      return within(cost.cost_per_outcome_usd, costOf(cost).perOutcome, 0.01);
    },
    tryNext:
      "run bun run cost on your file and copy its cost per outcome into cost_per_outcome_usd",
  },
  {
    says: "the cost is below the value of one outcome",
    test: (folder) => {
      if (!matchesSchema(folder)) return false;
      const cost = costFile(folder);
      return costOf(cost).perOutcome < cost.value_per_outcome_usd;
    },
    tryNext:
      "use fewer calls, fewer tokens or a cheaper model; " +
      "if none fit, the job is not worth an AI employee yet",
  },
] satisfies Rule[];
