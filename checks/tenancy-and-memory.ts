// Lab 03: each workspace keeps its secrets, its tone notes and its approvals to itself.

import { askMission } from "../apps/product-teammates/src/mission";
import {
  approveBriefing,
  publishedIn,
  readMemo,
  recallTone,
  rememberTone,
  resetWorkspace,
  submitBriefing,
} from "../apps/product-teammates/src/workspace";
import {
  MISSION_CONTROL_GOLDEN,
  MISSION_CONTROL_LAB_CASES,
} from "../data/catalog/golden-mission-control";
import { grade } from "../src/grade";
import { type Check, expect } from "../src/verify";

const NO_PAGES = {
  fetchRival: async (): Promise<string> => {
    throw new Error("A workspace question must not read a rival page.");
  },
};
const CORE = "core-growth";
const STEALTH = "enterprise-stealth";

function caseOf(name: string) {
  const found = [...MISSION_CONTROL_GOLDEN.cases, ...MISSION_CONTROL_LAB_CASES].find(
    (item) => item.name === name,
  );
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

async function askAs(person: string, question: string) {
  return askMission(question, person, NO_PAGES);
}

async function failsWith(work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
  } catch {
    return true;
  }
  return false;
}

export const checks: Check[] = [
  {
    name: "A person outside the workspace cannot read its memo",
    tryNext: "In readMemo, return nothing unless a member grant ties the person to the workspace.",
    run: async () => {
      const found = caseOf("titan-hidden");
      const result = await askAs("priya", found.question);
      expect(grade(found, result).ok, `The wall case failed: ${grade(found, result).reasons}`);
      expect(!result.text.includes("48 million"), "The deal size reached a person outside.");
      expect((await readMemo("priya", STEALTH)) === undefined, "readMemo opened the file.");
    },
  },
  {
    name: "The members of the workspace can read its memo",
    tryNext: "Read the memo file once the member grant is found.",
    run: async () => {
      const found = caseOf("titan-visible-to-owner");
      const truth = found.truth as { memo: string };
      const result = await askAs("marcus", found.question);
      expect(grade(found, result).ok, `The member case failed: ${grade(found, result).reasons}`);
      expect(result.text.includes(truth.memo), "The memo text is missing for the member.");
      const approver = await askAs("lena", found.question);
      expect(approver.text.includes(truth.memo), "A member of both workspaces was refused.");
    },
  },
  {
    name: "Tone notes stay inside one workspace and one person",
    tryNext: "In recallTone, filter on both the person and the workspace.",
    run: async () => {
      await resetWorkspace();
      const found = caseOf("tone-memory-scoped");
      const truth = found.truth as { tone: string };
      await rememberTone("priya", CORE, truth.tone);
      await rememberTone("lena", CORE, "warm and chatty");
      await rememberTone("lena", STEALTH, "formal and long");
      const result = await askAs("priya", found.question);
      expect(grade(found, result).ok, `The tone case failed: ${grade(found, result).reasons}`);
      expect(result.text.includes(truth.tone), `Priya did not get her tone: ${truth.tone}.`);
      expect(!result.text.includes("warm"), "Another person's tone reached Priya.");
      const lena = await askAs("lena", found.question);
      expect(lena.text.includes("warm and chatty"), "Lena did not get her workspace tone.");
      expect(!lena.text.includes("formal"), "A tone from another workspace reached Lena.");
      expect((await recallTone("marcus", STEALTH)) === undefined, "Marcus got a stranger's note.");
    },
  },
  {
    name: "An approver publishes a briefing from a fresh session",
    tryNext: "In approveBriefing, check the approves grant, then set the status to published.",
    run: async () => {
      await resetWorkspace();
      const found = caseOf("approval-resumes");
      const asked = await askAs("lena", found.question);
      expect(grade(found, asked).ok, `The approval case failed: ${grade(found, asked).reasons}`);
      const id = await submitBriefing("priya", CORE, "Churn is up for the Team plan.");
      expect((await publishedIn(CORE)).length === 0, "A briefing was published before approval.");
      expect(await failsWith(() => approveBriefing(id, "marcus")), "Marcus approved a briefing.");
      await approveBriefing(id, "lena");
      const published = await publishedIn(CORE);
      expect(
        published.includes("Churn is up for the Team plan."),
        "The briefing was not published.",
      );
      expect(await failsWith(() => approveBriefing(id, "lena")), "A briefing was approved twice.");
    },
  },
  {
    name: "A writer cannot approve their own briefing",
    tryNext: "In approveBriefing, throw when the approver is the writer.",
    run: async () => {
      await resetWorkspace();
      const found = caseOf("writer-cannot-approve");
      const id = await submitBriefing("priya", CORE, "Priya wrote this briefing.");
      const result = await askAs("priya", found.question);
      expect(grade(found, result).ok, `The writer case failed: ${grade(found, result).reasons}`);
      expect((await publishedIn(CORE)).length === 0, "The writer published their own briefing.");
      expect(await failsWith(() => approveBriefing(id, "priya")), "The writer approved it.");
      const own = await submitBriefing("lena", CORE, "Lena wrote this briefing.");
      expect(await failsWith(() => approveBriefing(own, "lena")), "An approver passed their own.");
    },
  },
];
