// Module 02: the agent reads only the label that is in force today.
import { DOCUMENTS, stateOf } from "../data/catalog/documents";
import {
  activeDocuments,
  ingestAll,
  ingestDocument,
  resetDocuments,
  storedDocument,
} from "../packages/core/src/ingestion";
import { type Check, expect } from "../src/verify";

async function freshStart(): Promise<void> {
  await resetDocuments();
  await ingestAll();
}

function find(slug: string) {
  const found = DOCUMENTS.find((item) => item.slug === slug);
  expect(found !== undefined, `The catalog has no document named ${slug}.`);
  return found;
}

export const checks: Check[] = [
  {
    name: "Only the current label is active",
    tryNext: "After each upload, mark the newest version in force today as the active one.",
    run: async () => {
      await freshStart();
      for (const document of DOCUMENTS) {
        const stored = await storedDocument(document.slug);
        expect(stored !== undefined, `${document.slug} was never stored.`);
        const wanted = stateOf(document) === "current";
        expect(
          stored.is_active === wanted,
          `${document.slug} should be ${wanted ? "active" : "hidden"}.`,
        );
      }
    },
  },
  {
    name: "The old label never reaches the agent",
    tryNext: "Search only the active documents. The old OncoX label must stay hidden.",
    run: async () => {
      await freshStart();
      const active = await activeDocuments("OncoX", "US");
      expect(active.length === 1, `OncoX in the US has ${active.length} active labels, not 1.`);
      expect(active[0].body.includes("150 mg"), "The active OncoX label is not the new one.");
      expect(!active[0].body.includes("100 mg"), "The old OncoX dose is still active.");
    },
  },
  {
    name: "The expired draft and the future label stay hidden",
    tryNext: "Hide a document before its start date and after its end date.",
    run: async () => {
      await freshStart();
      const draft = await storedDocument("cardioz-br-draft-v4");
      expect(draft?.is_active === false, "The expired CardioZ draft is still active.");
      const future = await storedDocument("oncox-us-label-v3");
      expect(future?.is_active === false, "The future OncoX label is already active.");
    },
  },
  {
    name: "A second upload of the same file is skipped",
    tryNext: "Hash the file bytes. When the hash matches, return unchanged_skipped.",
    run: async () => {
      await freshStart();
      const again = await ingestDocument(find("oncox-us-label-v2"));
      expect(again === "unchanged_skipped", `A repeat upload gave ${again}.`);
    },
  },
  {
    name: "The scanned page is read with OCR",
    tryNext: "Pass every page to the reader. A scan has no text layer, so it needs OCR.",
    run: async () => {
      await freshStart();
      const scan = await storedDocument("breathe-ez-br-scanned-page");
      expect(scan !== undefined, "The scanned page was never stored.");
      expect(scan.body.toLowerCase().includes("two puffs"), "The scanned dose was not read.");
    },
  },
];
