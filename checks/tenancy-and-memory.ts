// Lab 03: each workspace keeps its secrets, its tone notes and its approvals to itself.

import { MemorySaver } from "@langchain/langgraph";
import { askMission } from "../apps/product-teammates/src/mission";
import {
  approveBriefing,
  briefingsUnderWall,
  isWaiting,
  postgresSaver,
  publishedIn,
  readMemo,
  recallTone,
  rememberTone,
  resetWorkspace,
  resumeBriefing,
  seedWorkspaces,
  startBriefing,
  submitBriefing,
  toneUnderWall,
} from "../apps/product-teammates/src/workspace";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { rows } from "../packages/core/src/db";
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
  const found = MISSION_CONTROL_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

async function askAs(person: string, question: string) {
  return askMission(question, person, NO_PAGES);
}

async function failsWith(work: () => Promise<unknown>): Promise<boolean> {
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
  {
    name: "The two workspaces are seeded once",
    tryNext: "Insert each workspace with ON CONFLICT DO NOTHING. Leave the memo in the catalog.",
    run: async () => {
      await rows("DROP TABLE IF EXISTS workspaces");
      await seedWorkspaces();
      await seedWorkspaces();
      const names = await rows<{ name: string }>("SELECT name FROM workspaces ORDER BY name");
      expect(names.length === 2, `Found ${names.length} workspaces, wanted 2.`);
    },
  },
  {
    name: "The database hides notes and briefings from a person outside the workspace",
    tryNext: "Add a row policy that calls app_member, then read as the app_reader role.",
    run: async () => {
      await resetWorkspace();
      await rememberTone("lena", STEALTH, "formal and long");
      await rememberTone("lena", CORE, "warm and chatty");
      await submitBriefing("lena", STEALTH, "Titan briefing");
      expect((await toneUnderWall("priya", STEALTH)).length === 0, "Priya read a stealth note.");
      expect((await toneUnderWall("marcus", CORE)).length === 0, "Marcus read a core note.");
      const own = await toneUnderWall("lena", STEALTH);
      expect(own.length === 1 && own[0] === "formal and long", "Lena lost her own note.");
      expect((await briefingsUnderWall("priya")).length === 0, "Priya read a stealth briefing.");
      expect((await briefingsUnderWall("marcus")).length === 1, "Marcus lost his briefing.");
    },
  },
  {
    name: "A waiting briefing resumes on the same thread from a fresh session",
    tryNext: "Call interrupt() in one node, then resume the thread with a Command.",
    run: async (trial) => {
      await resetWorkspace();
      const thread = `briefing-${trial}-${Date.now()}`;
      const body = "Churn is up for the Team plan.";
      const first = await postgresSaver();
      await startBriefing(first, thread, { writer: "priya", workspace: CORE, body });
      expect(await isWaiting(first, thread), "The graph did not stop at the approval.");
      expect((await publishedIn(CORE)).length === 0, "A briefing published before approval.");
      const fresh = await postgresSaver();
      const asMarcus = { approver: "marcus", approved: true };
      expect(await failsWith(() => resumeBriefing(fresh, thread, asMarcus)), "Marcus approved.");
      const asPriya = { approver: "priya", approved: true };
      expect(await failsWith(() => resumeBriefing(fresh, thread, asPriya)), "The writer approved.");
      expect((await publishedIn(CORE)).length === 0, "A refused approval still published.");
      const status = await resumeBriefing(fresh, thread, { approver: "lena", approved: true });
      expect(status === "published", `The status was ${status}, wanted published.`);
      expect((await publishedIn(CORE)).includes(body), "The briefing did not publish.");
    },
  },
  {
    name: "A rejected briefing never publishes",
    tryNext: "Publish only when the saved status is approved.",
    run: async () => {
      await resetWorkspace();
      const saver = new MemorySaver();
      const brief = { writer: "priya", workspace: CORE, body: "Rejected body." };
      await startBriefing(saver, "reject-thread", brief);
      const status = await resumeBriefing(saver, "reject-thread", {
        approver: "lena",
        approved: false,
      });
      expect(status === "rejected", `The status was ${status}, wanted rejected.`);
      expect((await publishedIn(CORE)).length === 0, "A rejected briefing was published.");
    },
  },
];
