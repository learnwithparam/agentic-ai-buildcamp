import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { hasFile, readYaml, schemaIn, validate } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "04-list-tools-and-permissions");

type Tool = {
  does?: unknown;
  risk?: unknown;
  tenant?: unknown;
  approval?: unknown;
  must_never?: unknown;
};
type ToolsFile = { tools?: Tool[] } | undefined;

const toolsFile = (folder: string) => readYaml<ToolsFile>(folder, "tools.yaml");

function tools(folder: string): Tool[] {
  const listed = toolsFile(folder)?.tools;
  return Array.isArray(listed) ? listed : [];
}

// An empty value or a placeholder like "none" or "TODO" names nobody.
const namesNobody = (value: unknown) =>
  typeof value !== "string" || /^(none|nobody|no one|todo|-)?$/i.test(value.trim());

const riskFitsWhatItDoes = (tool: Tool) => (tool.does === "reads") === (tool.risk === "read");
const isGuarded = (tool: Tool) => !namesNobody(tool.approval) || !namesNobody(tool.must_never);

export default [
  {
    says: "tools.yaml exists and is valid YAML",
    test: (folder) => hasFile(folder, "tools.yaml") && typeof toolsFile(folder) === "object",
    tryNext: "create tools.yaml in this folder and check the indents line up",
  },
  {
    says: "tools.yaml matches tools.schema.json",
    test: (folder) => {
      const schema = schemaIn(STEP, "tools.schema.json");
      return validate(schema, toolsFile(folder)).length === 0;
    },
    tryNext: "give every tool a name, does, risk, tenant and approval, as in the README's shape",
  },
  {
    says: "every tool's risk fits what it does",
    test: (folder) => tools(folder).length > 0 && tools(folder).every(riskFitsWhatItDoes),
    tryNext:
      "a tool that reads has risk read; a tool that writes is an undoable write or a final write",
  },
  {
    says: "every final write has an approver or a must-never",
    test: (folder) => {
      const finalWrites = tools(folder).filter((tool) => tool.risk === "final write");
      return finalWrites.length > 0 && finalWrites.every(isGuarded);
    },
    tryNext: "for each final write, name who approves it, or the must-never rule that guards it",
  },
  {
    says: "no tool reads or writes another tenant",
    test: (folder) =>
      tools(folder).length > 0 && tools(folder).every((tool) => tool.tenant === "own"),
    tryNext: "set tenant: own on every tool; an employee only touches its own tenant's rows",
  },
] satisfies Rule[];
