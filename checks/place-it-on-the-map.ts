import type { Rule } from "../scripts/verify";
import { has, sections, text } from "./design-lib";

const map = (d: string) => sections(text(d, "map.md"));
const choice = (d: string) =>
  (map(d)["choice"] ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    .toLowerCase()
    .replace(/[.*_`]/g, "") ?? "";
const decider = (d: string) =>
  (map(d)["why"] ?? "")
    .match(/who decides the next step:\s*(the\s+)?(code|model)/i)?.[2]
    ?.toLowerCase();

export default [
  {
    says: "map.md exists",
    test: (d) => has(d, "map.md"),
    tryNext: "create map.md in this step's problem folder",
  },
  {
    says: "map.md has the sections Problem, Choice and Why",
    test: (d) => ["problem", "choice", "why"].every((s) => (map(d)[s] ?? "").length > 0),
    tryNext: "add three headings, ## Problem, ## Choice and ## Why, each with text under it",
  },
  {
    says: "the Problem names a cost with a number",
    test: (d) => {
      const p = map(d)["problem"] ?? "";
      return /\d/.test(p) && /(USD|EUR|GBP|INR|\$|€|£|cost|fee|paid|lost|minutes)/i.test(p);
    },
    tryNext: "say what the problem costs, with a number, like: paid USD 3,140 twice",
  },
  {
    says: "the first line of Choice is workflow, agent or agentic system",
    test: (d) => ["workflow", "agent", "agentic system"].includes(choice(d)),
    tryNext:
      "start the Choice section with one line that is exactly workflow, agent or agentic system",
  },
  {
    says: "Why says who decides the next step: code or the model",
    test: (d) => decider(d) !== undefined,
    tryNext: "add a line to Why like: Who decides the next step: the model",
  },
  {
    says: "the Choice and the decider agree",
    test: (d) => (choice(d) === "workflow" ? decider(d) === "code" : decider(d) === "model"),
    tryNext:
      "a workflow means code decides every next step; an agent or agentic system means the model decides",
  },
] satisfies Rule[];
