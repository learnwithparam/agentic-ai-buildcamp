// Module 05: the agent asks numbers questions through a tool that guards every query.
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { PRESCRIBERS } from "../data/catalog/prescribers";
import { answerData, guardQuery, inspectSchema } from "../packages/core/src/bi";
import { flushTraces, traced } from "../packages/core/src/telemetry";
import { allSpansOfTrace, spansWithRunId } from "../src/spans";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "pharma-a", agentName: "bi-check" };

function caseOf(name: string) {
  const found = HCP_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

const LOWEST_TERRITORY = `SELECT territory, SUM(new_prescriptions) AS total
  FROM pharma_a.territory_rx_weekly
  WHERE brand = 'CardioZ' AND week_start BETWEEN '2026-06-01' AND '2026-06-30'
  GROUP BY territory ORDER BY total ASC LIMIT 1`;

const OCTOBER_SALES = `SELECT SUM(net_sales_usd) AS sales FROM pharma_b.commercial_dispenses
  WHERE product = 'DermaClear' AND month = '2026-10'`;

export const checks: Check[] = [
  {
    name: "Each workspace shows its own table shape",
    tryNext: "In inspectSchema, read the columns of the workspace schema from information_schema.",
    run: async () => {
      const first = await inspectSchema("pharma_a", TAGS);
      const second = await inspectSchema("pharma_b", TAGS);
      const weekly = first.find((shape) => shape.table === "pharma_a.territory_rx_weekly");
      const monthly = second.find((shape) => shape.table === "pharma_b.commercial_dispenses");
      expect(weekly?.columns.includes("week_start") === true, "Workspace A has no weekly table.");
      expect(monthly?.columns.includes("region") === true, "Workspace B has no monthly table.");
      const names = [...first, ...second].map((shape) => shape.table).join(" ");
      expect(!names.includes("prescribers"), "The prescriber table is visible to the agent.");
    },
  },
  {
    name: "The weekly question gets the true lowest territory",
    tryNext: "Run the checked query and return its rows as the answer.",
    run: async () => {
      const found = caseOf("territory-dip");
      const writer = async () => LOWEST_TERRITORY;
      const result = await answerData(found.question, "pharma-a", TAGS, writer);
      const truth = found.truth as { territory: string };
      expect(result.route === "answer", `The route was ${result.route}, wanted answer.`);
      expect(result.text.includes(truth.territory), `The answer is not ${truth.territory}.`);
    },
  },
  {
    name: "The monthly question works on the second shape",
    tryNext: "Look up the schema of the tenant, never a fixed table.",
    run: async () => {
      const found = caseOf("second-schema");
      const writer = async () => OCTOBER_SALES;
      const result = await answerData(found.question, "pharma-b", TAGS, writer);
      const truth = found.truth as { netSalesUsd: number };
      expect(result.text.includes(String(truth.netSalesUsd)), "The sales number is wrong.");
    },
  },
  {
    name: "A query for private columns is refused",
    tryNext: "In guardQuery, refuse a query that names email, npi or a name column.",
    run: async () => {
      const found = caseOf("no-row-in-trace");
      const writer = async () => "SELECT email FROM prescribers WHERE territory = 'Great Lakes'";
      const result = await answerData(found.question, "pharma-a", TAGS, writer);
      expect(result.route === "refuse", "A query for emails was run.");
      const hidden = guardQuery("SELECT MIN(email) FROM pharma_a.territory_rx_weekly", "pharma_a");
      expect(hidden !== undefined, "MIN(email) slipped past the guard.");
    },
  },
  {
    name: "A query on another workspace or a write is refused",
    tryNext: "In guardQuery, allow only select, one statement, and tables of this workspace.",
    run: async () => {
      const other = "SELECT SUM(units_dispensed) FROM pharma_b.commercial_dispenses";
      expect(guardQuery(other, "pharma_a") !== undefined, "Another workspace was readable.");
      const drop = "DELETE FROM pharma_a.territory_rx_weekly";
      expect(guardQuery(drop, "pharma_a") !== undefined, "A write was allowed.");
      const two = "SELECT 1 FROM pharma_a.territory_rx_weekly; SELECT 2";
      expect(guardQuery(two, "pharma_a") !== undefined, "Two statements were allowed.");
    },
  },
  {
    name: "No private value reaches any span",
    tryNext: "Keep rows out of span attributes. Record only the query and the row count.",
    run: async (trial) => {
      const runId = `${Date.now()}-bi-${trial}`;
      const writer = async () => LOWEST_TERRITORY;
      await traced("bi-check", TAGS, async (setAttributes) => {
        setAttributes({ run_id: runId });
        return answerData("Which territory sold least?", "pharma-a", TAGS, writer);
      });
      await flushTraces();
      const parents = await spansWithRunId(runId);
      const spans = await allSpansOfTrace(parents[0]?.context.trace_id ?? "");
      const query = spans.find((span) => span.name === "bi.query");
      expect(query?.attributes.row_count === 1, "The query span has no row count.");
      const text = JSON.stringify(spans);
      const leaked = PRESCRIBERS.find(
        (item) => text.includes(item.npi) || text.includes(item.email),
      );
      expect(leaked === undefined, "A prescriber NPI or email reached a span.");
    },
  },
];
