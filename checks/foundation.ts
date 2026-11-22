// Module 00: the stack is up, the seed is loaded, and the naive agent fails in plain view.

import { naivePrompt } from "../apps/hcp-showcase/src/naive";
import { DOCUMENTS } from "../data/catalog/documents";
import { PRESCRIBERS } from "../data/catalog/prescribers";
import { rows } from "../packages/core/src/db";
import { type Check, expect } from "../src/verify";

const QUESTION = "What is the OncoX dose in the United States?";

async function countOf(table: string): Promise<number> {
  const [found] = await rows<{ count: string }>(`SELECT count(*) FROM ${table}`);
  return Number(found.count);
}

export const checks: Check[] = [
  {
    name: "Postgres answers and holds the seed",
    tryNext: "Run bun run up, then run this check again.",
    run: async () => {
      const people = await countOf("people").catch(() => 0);
      expect(people > 0, "Postgres has no people. Run bun run up first.");
      const grants = await countOf("grants");
      expect(grants > 0, "The grants table is empty. Run bun run up again.");
    },
  },
  {
    name: "Phoenix answers on port 6006",
    tryNext: "Run bun run up. Phoenix needs a few seconds to start.",
    run: async () => {
      const reply = await fetch("http://localhost:6006/healthz").catch(() => undefined);
      expect(reply?.ok === true, "Phoenix did not answer on port 6006.");
    },
  },
  {
    name: "The naive prompt pastes in every document",
    tryNext: "In naivePrompt, join the title and body of every document into the prompt.",
    run: async () => {
      const prompt = naivePrompt(QUESTION);
      for (const document of DOCUMENTS) {
        expect(prompt.includes(document.body), `The prompt is missing ${document.slug}.`);
      }
    },
  },
  {
    name: "The naive prompt leaks prescriber emails",
    tryNext: "In naivePrompt, add the name, NPI and email of every prescriber.",
    run: async () => {
      const prompt = naivePrompt(QUESTION);
      for (const doctor of PRESCRIBERS) {
        expect(prompt.includes(doctor.email), `The prompt is missing ${doctor.name}.`);
      }
    },
  },
];
