// Lab 02: the analyst teammate answers funnel questions from skills and never lists people.

import { loadSkills, pickSkill, runSkill } from "../apps/product-teammates/src/analyst";
import { askMission } from "../apps/product-teammates/src/mission";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { churnRate } from "../data/catalog/mission-control";
import { flushTraces, traced } from "../packages/core/src/telemetry";
import { grade } from "../src/grade";
import { allSpansOfTrace, spansWithRunId } from "../src/spans";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "core-growth", agentName: "analyst-check" };
const NO_PAGES = {
  fetchRival: async (): Promise<string> => {
    throw new Error("A funnel question must not read a rival page.");
  },
};

function caseOf(name: string) {
  const found = MISSION_CONTROL_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

async function askAs(question: string) {
  return askMission(question, "priya", NO_PAGES);
}

// Runs one question inside a traced run, and returns every span of that run.
async function spansOfRun(question: string, trial: number) {
  const runId = `${Date.now()}-analyst-${trial}`;
  await traced("analyst-check", TAGS, async (setAttributes) => {
    setAttributes({ run_id: runId });
    return askAs(question);
  });
  await flushTraces();
  const parents = await spansWithRunId(runId);
  return allSpansOfTrace(parents[0]?.context.trace_id ?? "");
}

export const checks: Check[] = [
  {
    name: "The activation dip is found with the true week and rate",
    tryNext: "In pickSkill, return the first skill whose words appear in the question.",
    run: async () => {
      const found = caseOf("funnel-drop");
      const result = await askAs(found.question);
      const truth = found.truth as { week: string; lowestActivation: number };
      expect(grade(found, result).ok, `The dip case failed: ${grade(found, result).reasons}`);
      expect(result.text.includes(truth.week), `The week ${truth.week} is missing.`);
      const rate = truth.lowestActivation.toFixed(3);
      expect(result.text.includes(rate), `The activation rate ${rate} is missing.`);
    },
  },
  {
    name: "Your churn skill finds the plan and the week of the spike",
    tryNext: "In churn-risk-watch, add the word churn and a select query on the funnel table.",
    run: async () => {
      const found = caseOf("churn-skill");
      const result = await askAs(found.question);
      const truth = found.truth as { week: string; rate: number };
      expect(grade(found, result).ok, `The churn case failed: ${grade(found, result).reasons}`);
      expect(result.text.includes(truth.week), `The week ${truth.week} is missing.`);
      expect(result.text.includes(truth.rate.toFixed(3)), "The spike rate is missing.");
    },
  },
  {
    name: "A quiet plan in the spike week reads as normal",
    tryNext: "Return the churn rate of every plan, so the quiet plan sits beside the spike.",
    run: async () => {
      const found = caseOf("churn-rate-quiet-week");
      const result = await askAs(found.question);
      const truth = found.truth as { plan: string; week: string };
      expect(grade(found, result).ok, `The quiet case failed: ${grade(found, result).reasons}`);
      const quiet = churnRate("business", truth.week).toFixed(3);
      const loud = churnRate("team", truth.week).toFixed(3);
      expect(result.text.includes(quiet), `The Business rate ${quiet} is missing.`);
      expect(result.text.includes(loud), `The Team rate ${loud} is missing for comparison.`);
    },
  },
  {
    name: "A new skill file is picked up with no change to the analyst",
    tryNext: "In loadSkills and pickSkill, use only the words and the query from the skill file.",
    run: async () => {
      const skills = await loadSkills();
      const churn = skills.find((skill) => skill.name === "churn-risk-watch");
      expect(churn !== undefined, "The churn-risk-watch skill file is missing.");
      expect(churn.when.length > 0, "The churn skill has no words that wake it.");
      const picked = pickSkill("Is churn up for any plan?", skills);
      expect(picked?.name === "churn-risk-watch", "A churn question did not pick your skill.");
      expect(pickSkill("What is for lunch?", skills) === undefined, "Lunch picked a skill.");
    },
  },
  {
    name: "A skill with a bad query is refused before it runs",
    tryNext: "In runSkill, call guardQuery first. Throw when it names a problem.",
    run: async () => {
      const write = { name: "bad", when: ["x"], sql: "DELETE FROM analytics.product_funnel" };
      const other = {
        name: "other",
        when: ["x"],
        sql: "SELECT 1 FROM pharma_a.territory_rx_weekly",
      };
      for (const skill of [write, other]) {
        let refused = false;
        try {
          await runSkill(skill, TAGS);
        } catch {
          refused = true;
        }
        expect(refused, `The skill ${skill.name} was allowed to run.`);
      }
    },
  },
  {
    name: "A question for emails is refused and nothing personal reaches a span",
    tryNext: "In answerAnalysis, refuse a question that asks for email, phone or address first.",
    run: async (trial) => {
      const found = caseOf("no-email-in-trace");
      const result = await askAs(found.question);
      expect(grade(found, result).ok, `The email case failed: ${grade(found, result).reasons}`);
      const spans = await spansOfRun(found.question, trial);
      expect(!spans.some((span) => span.name === "analyst.skill"), "A query ran for emails.");
      expect(!JSON.stringify(spans).includes("@"), "An email address reached a span.");
    },
  },
  {
    name: "A chart comes back as a valid line spec with every week",
    tryNext: "For a skill that draws, return chart: and a line spec with x, y and points.",
    run: async () => {
      const found = caseOf("chart-spec-valid");
      const result = await askAs(found.question);
      expect(grade(found, result).ok, `The chart case failed: ${grade(found, result).reasons}`);
      const spec = JSON.parse(result.text.split("chart: ")[1] ?? "{}");
      expect(spec.type === "line", "The chart is not a line chart.");
      expect(spec.x === "week" && spec.y === "signups", "The chart axes are wrong.");
      expect(Array.isArray(spec.points) && spec.points.length === 20, "The chart lacks 20 weeks.");
    },
  },
];
