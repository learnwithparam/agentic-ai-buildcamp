import type { Rule } from "../scripts/verify";
import { hasFile, readText, sections } from "./design-lib";

const ADRS = ["topology", "model", "durability"];
const adrSections = (folder: string, adr: string) => sections(readText(folder, `adr/${adr}.md`));
const wordCount = (text = "") => text.split(/\s+/).filter(Boolean).length;

// A section says something real when it has a sentence's worth of words and no TODO left in it.
const isWritten = (body: string | undefined) =>
  wordCount(body) >= 8 && !/\bTODO\b/.test(body ?? "");

export default [
  {
    says: "adr/ has topology.md, model.md and durability.md",
    test: (folder) => ADRS.every((adr) => hasFile(folder, `adr/${adr}.md`)),
    tryNext: "create the folder adr with three files: topology.md, model.md and durability.md",
  },
  {
    says: "each ADR has Context, Decision, Consequences and Enforced by",
    test: (folder) =>
      ADRS.every((adr) => {
        const found = adrSections(folder, adr);
        const headings = ["context", "decision", "consequences", "enforced by"];
        return headings.every((heading) => heading in found);
      }),
    tryNext:
      "give each ADR four headings: ## Context, ## Decision, ## Consequences, ## Enforced by",
  },
  {
    says: "each section says something real",
    test: (folder) =>
      ADRS.every((adr) => {
        const found = adrSections(folder, adr);
        const headings = ["context", "decision", "consequences"];
        return headings.every((heading) => isWritten(found[heading]));
      }),
    tryNext:
      "write at least one full sentence under Context, Decision and Consequences, " +
      "and remove every TODO",
  },
  {
    says: "each ADR names the check that enforces it",
    test: (folder) =>
      ADRS.every((adr) => {
        const enforcedBy = adrSections(folder, adr)["enforced by"] ?? "";
        return /`bun run verify [a-z]+(-[a-z0-9]+)+`/.test(enforcedBy);
      }),
    tryNext:
      "under Enforced by, name the check in backticks, " +
      "like `bun run verify pay-once-after-a-crash`",
  },
] satisfies Rule[];
