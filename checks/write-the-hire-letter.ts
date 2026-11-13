import type { Rule } from "../scripts/verify";
import { type HireLetter, hasFile, isQuery, readToml } from "./design-lib";

type EmployeeFile = { hire?: HireLetter };

const employeeFile = (folder: string) => readToml<EmployeeFile>(folder, "employee.toml");
const hire = (folder: string): HireLetter => employeeFile(folder).hire ?? {};

// A text value still holding the template's placeholder is not filled in yet.
function isFilled(value: unknown): boolean {
  if (typeof value !== "string") return value !== undefined;
  const text = value.trim();
  return text.length > 0 && !/^(todo|tbd|write here)/i.test(text);
}

const STARTERS = ["person", "event", "schedule", "agent"];

export default [
  {
    says: "employee.toml exists and is valid TOML",
    test: (folder) => hasFile(folder, "employee.toml") && typeof employeeFile(folder) === "object",
    tryNext: "create employee.toml in this folder and check every text value has quotes",
  },
  {
    says: "[hire] has outcome, metric, must_never, starts_by and lives",
    test: (folder) => {
      const letter: Record<string, unknown> = hire(folder);
      const keys = ["outcome", "metric", "must_never", "starts_by", "lives"];
      return keys.every((key) => isFilled(letter[key]));
    },
    tryNext: "fill every key under [hire]; replace each TODO with your own words",
  },
  {
    says: "starts_by lists person, event, schedule or agent",
    test: (folder) => {
      const startsBy = hire(folder).starts_by;
      return (
        Array.isArray(startsBy) &&
        startsBy.length > 0 &&
        startsBy.every((starter) => STARTERS.includes(starter))
      );
    },
    tryNext:
      "set starts_by to a list of one or more of: person, event, schedule, agent, " +
      'like starts_by = ["person"]',
  },
  {
    says: "lives is one job, one case or always on",
    test: (folder) => ["one job", "one case", "always on"].includes(hire(folder).lives ?? ""),
    tryNext: "set lives to one of: one job, one case, always on",
  },
  {
    says: "the metric has a name and a query on the system of record",
    test: (folder) => {
      const metric = hire(folder).metric;
      return isFilled(metric?.name) && isQuery(metric?.query);
    },
    tryNext:
      "under [hire.metric] give a name and a query that starts with SELECT and reads a table",
  },
  {
    says: "must_never names a write tool and a query that finds it",
    test: (folder) => {
      const mustNever = hire(folder).must_never ?? {};
      const writeTool = mustNever.write ?? "";
      return (
        isFilled(mustNever.rule) && /^[a-z]+(_[a-z]+)+$/.test(writeTool) && isQuery(mustNever.check)
      );
    },
    tryNext:
      "under [hire.must_never] set rule, write (the tool name, like pay_invoice) " +
      "and check (a SELECT that returns the forbidden rows)",
  },
] satisfies Rule[];
