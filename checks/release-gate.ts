// Module 10: a release goes out only when every golden case passes.
import { runGolden } from "../apps/hcp-showcase/src/scoreboard";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { resetApprovals } from "../packages/core/src/approvals";
import { rows } from "../packages/core/src/db";
import { gate, gateText } from "../packages/core/src/gate";
import { ingestAll, resetDocuments } from "../packages/core/src/ingestion";
import { askTeam } from "../packages/core/src/team";
import type { Grade } from "../src/grade";
import { needsModel, quotingModels } from "../src/offline";
import { type Check, expect } from "../src/verify";

const OFFLINE: typeof HCP_GOLDEN = {
  track: "hcp",
  cases: HCP_GOLDEN.cases.filter(
    (item) => !needsModel(item.name) && !item.name.startsWith("NAIVE"),
  ),
};

async function freshDocuments(): Promise<void> {
  await resetApprovals();
  await resetDocuments();
  await ingestAll();
}

async function runOffline() {
  const models = quotingModels();
  const agent = (question: string, persona: string) => askTeam(question, persona, models);
  return runGolden(agent, OFFLINE);
}

export const checks: Check[] = [
  {
    name: "Every golden case that needs no model passes",
    tryNext: "Fix the case named in the gate report. Do not edit the golden set.",
    run: async () => {
      await freshDocuments();
      const result = gate(OFFLINE, await runOffline());
      expect(result.open, gateText(result));
      expect(result.total >= 15, "The offline gate ran too few golden cases.");
    },
  },
  {
    name: "A bad answer closes the gate and names the case",
    tryNext: "In gate, list each failed case by name with its reasons, and close the gate.",
    run: async () => {
      await freshDocuments();
      const grades = await runOffline();
      grades[0] = { ok: false, reasons: ["the answer holds old dose: 100 mg"] };
      const result = gate(OFFLINE, grades);
      expect(!result.open, "A failed case did not close the gate.");
      expect(result.failures.length === 1, "The gate named the wrong number of failures.");
      expect(result.failures[0].startsWith(OFFLINE.cases[0].name), "The report lacks the name.");
      expect(gateText(result).includes("old dose"), "The report lacks the reason.");
    },
  },
  {
    name: "A one line change that brings back the old label is caught",
    tryNext: "Run the whole set before every release. The stale dose case must stay in it.",
    run: async () => {
      await freshDocuments();
      const brand = "DermaClear";
      await rows("UPDATE documents SET is_active = true WHERE brand = $1 AND type = 'label'", [
        brand,
      ]);
      const result = gate(OFFLINE, await runOffline());
      expect(!result.open, "The old label came back and the gate stayed open.");
      const hit = result.failures.find((line) => line.startsWith("regression-caught"));
      expect(hit !== undefined, "The report does not name regression-caught.");
      expect(hit.includes("a thin layer once daily"), "The report does not show the old dose.");
    },
  },
  {
    name: "Passing the golden set once is not enough, the gate counts every case",
    tryNext: "Compare the passed count with the total, and open the gate only when they match.",
    run: async () => {
      const grades: Grade[] = OFFLINE.cases.map(() => ({ ok: true, reasons: [] }));
      grades[grades.length - 1] = { ok: false, reasons: ["wrong"] };
      const result = gate(OFFLINE, grades);
      expect(result.passed === grades.length - 1, "The gate counted the wrong number of passes.");
      expect(!result.open, "One failure out of many left the gate open.");
    },
  },
];
