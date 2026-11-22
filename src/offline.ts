// A stand-in model for the release gate. It quotes every document the agent shows it.
// So the gate tests what retrieval and the rules let through, not how well a model writes.
import type { Models } from "../packages/core/src/team";
import { UNITS } from "./workshop";

const BLOCK = /\[([a-z0-9-]+)\]\n([\s\S]*?)(?=\n\n\[|\n\nQuestion:)/g;

export function quotingModels(): Models {
  return {
    generate: async (prompt) => {
      const blocks = [...prompt.matchAll(BLOCK)];
      if (blocks.length === 0) return "NOT_IN_DOCUMENTS";
      return blocks.map((block) => `${block[2].trim()} [${block[1]}]`).join("\n");
    },
    writeQuery: async () => {
      throw new Error("Numbers questions need a recorded or live model.");
    },
  };
}

// These cases need a model to write a query or to judge a date. The stand-in cannot.
const JUDGMENT: string[] = ["future-label-not-yet", "unanswerable-refused"];

export function needsModel(name: string): boolean {
  const units = UNITS.filter((unit) => unit.slug === "analytics-mcp" || unit.slug === "surfaces");
  return JUDGMENT.includes(name) || units.some((unit) => unit.cases.includes(name));
}
