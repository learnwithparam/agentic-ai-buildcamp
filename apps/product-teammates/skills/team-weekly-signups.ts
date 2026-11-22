import type { Skill } from "../src/analyst";

// Signups of the Team plan, one point for each week, drawn as a line.
export const skill: Skill = {
  name: "team-weekly-signups",
  when: ["draw", "chart", "plot"],
  chart: true,
  sql: `SELECT week_start::text AS week, signups
    FROM analytics.product_funnel
    WHERE plan = 'team'
    ORDER BY week_start`,
};
