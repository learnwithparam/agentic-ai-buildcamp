import type { Rule } from "../scripts/verify";
import { has, isQuery, toml } from "./design-lib";

const hire = (d: string) => toml(d, "employee.toml").hire ?? {};
const filled = (v: unknown) =>
  typeof v === "string" ? v.trim().length > 0 && !/^(todo|tbd|write here)/i.test(v.trim()) : v !== undefined;

export default [
  {
    says: "employee.toml exists and is valid TOML",
    test: (d) => has(d, "employee.toml") && typeof toml(d, "employee.toml") === "object",
    tryNext: "create employee.toml in this folder and check every text value has quotes",
  },
  {
    says: "[hire] has outcome, metric, must_never, starts_by and lives",
    test: (d) => ["outcome", "metric", "must_never", "starts_by", "lives"].every((k) => filled(hire(d)[k])),
    tryNext: "fill every key under [hire]; replace each TODO with your own words",
  },
  {
    says: "starts_by lists person, event, schedule or agent",
    test: (d) => {
      const s = hire(d).starts_by;
      return Array.isArray(s) && s.length > 0 && s.every((x) => ["person", "event", "schedule", "agent"].includes(x));
    },
    tryNext: "set starts_by to a list of one or more of: person, event, schedule, agent, like starts_by = [\"person\"]",
  },
  {
    says: "lives is one job, one case or always on",
    test: (d) => ["one job", "one case", "always on"].includes(hire(d).lives),
    tryNext: "set lives to one of: one job, one case, always on",
  },
  {
    says: "the metric has a name and a query on the system of record",
    test: (d) => filled(hire(d).metric?.name) && isQuery(hire(d).metric?.query),
    tryNext: "under [hire.metric] give a name and a query that starts with SELECT and reads a table",
  },
  {
    says: "must_never names a write tool and a query that finds it",
    test: (d) => {
      const m = hire(d).must_never ?? {};
      return filled(m.rule) && /^[a-z]+(_[a-z]+)+$/.test(m.write ?? "") && isQuery(m.check);
    },
    tryNext: "under [hire.must_never] set rule, write (the tool name, like pay_invoice) and check (a SELECT that returns the forbidden rows)",
  },
] satisfies Rule[];
