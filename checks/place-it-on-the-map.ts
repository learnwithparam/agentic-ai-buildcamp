import type { Rule } from "../scripts/verify";
import { hasFile, readText, sections } from "./design-lib";

const mapSections = (folder: string) => sections(readText(folder, "map.md"));

// The first line of the Choice section, in lower case, without Markdown emphasis.
function choice(folder: string): string {
  const lines = (mapSections(folder).choice ?? "").split("\n");
  const firstLine = lines.find((line) => line.trim());
  if (firstLine === undefined) return "";
  const lowerCase = firstLine.trim().toLowerCase();
  return lowerCase.replace(/[.*_`]/g, "");
}

// "code" or "model", from the line "Who decides the next step: ..." in the Why section.
function decider(folder: string): string | undefined {
  const why = mapSections(folder).why ?? "";
  const found = why.match(/who decides the next step:\s*(the\s+)?(code|model)/i);
  return found?.[2]?.toLowerCase();
}

const COST_WORD = /(USD|EUR|GBP|INR|\$|€|£|cost|fee|paid|lost|minutes)/i;

export default [
  {
    says: "map.md exists",
    test: (folder) => hasFile(folder, "map.md"),
    tryNext: "create map.md in this step's problem folder",
  },
  {
    says: "map.md has the sections Problem, Choice and Why",
    test: (folder) => {
      const found = mapSections(folder);
      return ["problem", "choice", "why"].every((name) => (found[name] ?? "").length > 0);
    },
    tryNext: "add three headings, ## Problem, ## Choice and ## Why, each with text under it",
  },
  {
    says: "the Problem names a cost with a number",
    test: (folder) => {
      const problem = mapSections(folder).problem ?? "";
      return /\d/.test(problem) && COST_WORD.test(problem);
    },
    tryNext: "say what the problem costs, with a number, like: paid USD 3,140 twice",
  },
  {
    says: "the first line of Choice is workflow, agent or agentic system",
    test: (folder) => ["workflow", "agent", "agentic system"].includes(choice(folder)),
    tryNext:
      "start the Choice section with one line that is exactly workflow, agent or agentic system",
  },
  {
    says: "Why says who decides the next step: code or the model",
    test: (folder) => decider(folder) !== undefined,
    tryNext: "add a line to Why like: Who decides the next step: the model",
  },
  {
    says: "the Choice and the decider agree",
    test: (folder) => {
      if (choice(folder) === "workflow") return decider(folder) === "code";
      return decider(folder) === "model";
    },
    tryNext:
      "a workflow means code decides every next step; " +
      "an agent or agentic system means the model decides",
  },
] satisfies Rule[];
