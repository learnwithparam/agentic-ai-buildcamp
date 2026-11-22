import type { Skill } from "../src/analyst";

// Finds the week and plan with the fewest sign-ups that became active users.
export const skill: Skill = {
  name: "activation-dip",
  when: ["activation", "signups fall", "drop"],
  sql: `SELECT week_start::text AS week, plan,
    round(activated::numeric / signups, 3) AS activation
    FROM analytics.product_funnel
    ORDER BY activated::numeric / signups LIMIT 1`,
};
