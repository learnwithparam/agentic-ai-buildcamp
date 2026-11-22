import type { Skill } from "../src/analyst";

// #region lab:product-intelligence-bi
// The churn rate of every plan in the week where one plan churned the most.
export const skill: Skill = {
  name: "churn-risk-watch",
  when: ["churn"],
  sql: `SELECT plan, week_start::text AS week,
    round(churned::numeric / signups, 3) AS churn_rate
    FROM analytics.product_funnel
    WHERE week_start = (
      SELECT week_start FROM analytics.product_funnel
      ORDER BY churned::numeric / signups DESC LIMIT 1)
    ORDER BY churn_rate DESC`,
};
// #stub
//~ // TODO(product-intelligence-bi): write the churn skill: the words that wake it and one query
//~ export const skill: Skill = { name: "churn-risk-watch", when: [], sql: "" };
// #endregion
