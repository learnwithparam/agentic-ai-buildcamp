import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { has, schemaIn, validate, yaml } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "04-list-tools-and-permissions");
const file = (d: string) => yaml(d, "tools.yaml");
const tools = (d: string): any[] => (Array.isArray(file(d)?.tools) ? file(d).tools : []);
const none = (s: unknown) => typeof s !== "string" || /^(none|nobody|no one|todo|-)?$/i.test(s.trim());

export default [
  {
    says: "tools.yaml exists and is valid YAML",
    test: (d) => has(d, "tools.yaml") && typeof file(d) === "object",
    tryNext: "create tools.yaml in this folder and check the indents line up",
  },
  {
    says: "tools.yaml matches tools.schema.json",
    test: (d) => validate(schemaIn(STEP, "tools.schema.json"), file(d)).length === 0,
    tryNext: "give every tool a name, does, risk, tenant and approval, as in the README's shape",
  },
  {
    says: "every tool's risk fits what it does",
    test: (d) => tools(d).length > 0 && tools(d).every((t) => (t.does === "reads") === (t.risk === "read")),
    tryNext: "a tool that reads has risk read; a tool that writes is an undoable write or a final write",
  },
  {
    says: "every final write has an approver or a must-never",
    test: (d) => {
      const finals = tools(d).filter((t) => t.risk === "final write");
      return finals.length > 0 && finals.every((t) => !none(t.approval) || !none(t.must_never));
    },
    tryNext: "for each final write, name who approves it, or the must-never rule that guards it",
  },
  {
    says: "no tool reads or writes another tenant",
    test: (d) => tools(d).length > 0 && tools(d).every((t) => t.tenant === "own"),
    tryNext: "set tenant: own on every tool; an employee only touches its own tenant's rows",
  },
] satisfies Rule[];
