import type { Rule } from "../scripts/verify";
import { has, sections, text } from "./design-lib";

const ADRS = ["topology", "model", "durability"];
const adr = (d: string, n: string) => sections(text(d, `adr/${n}.md`));
const words = (s = "") => s.split(/\s+/).filter(Boolean).length;

export default [
  {
    says: "adr/ has topology.md, model.md and durability.md",
    test: (d) => ADRS.every((n) => has(d, `adr/${n}.md`)),
    tryNext: "create the folder adr with three files: topology.md, model.md and durability.md",
  },
  {
    says: "each ADR has Context, Decision, Consequences and Enforced by",
    test: (d) => ADRS.every((n) => ["context", "decision", "consequences", "enforced by"].every((s) => s in adr(d, n))),
    tryNext: "give each ADR four headings: ## Context, ## Decision, ## Consequences, ## Enforced by",
  },
  {
    says: "each section says something real",
    test: (d) =>
      ADRS.every((n) => ["context", "decision", "consequences"].every((s) => words(adr(d, n)[s]) >= 8 && !/\bTODO\b/.test(adr(d, n)[s]))),
    tryNext: "write at least one full sentence under Context, Decision and Consequences, and remove every TODO",
  },
  {
    says: "each ADR names the check that enforces it",
    test: (d) => ADRS.every((n) => /`bun run verify [a-z]+(-[a-z0-9]+)+`/.test(adr(d, n)["enforced by"] ?? "")),
    tryNext: "under Enforced by, name the check in backticks, like `bun run verify pay-once-after-a-crash`",
  },
] satisfies Rule[];
