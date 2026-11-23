// Module 10: a person must say yes before a reply is sent, and a restart loses nothing.
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import {
  approvalCard,
  approvalsCli,
  cardsFor,
  cardText,
  decide,
  pendingFor,
  pressCard,
  recall,
  recallFor,
  resetApprovals,
  stopApprovals,
} from "../packages/core/src/approvals";
import { closeDatabase, rows } from "../packages/core/src/db";
import { askTeam, type Models } from "../packages/core/src/team";
import { grade } from "../src/grade";
import { type Check, expect } from "../src/verify";

let modelCalls = 0;
const MODELS: Models = {
  generate: async () => {
    modelCalls += 1;
    return "NOT_IN_DOCUMENTS";
  },
  writeQuery: async () => {
    modelCalls += 1;
    return "SELECT 1";
  },
};

const REPORT = "Thanks for the leaflet. By the way my patient got a rash after CardioZ.";

// A restart: close the graph, the memory and the pool. The next call opens them again.
async function restart(): Promise<void> {
  await stopApprovals();
  await closeDatabase();
}

async function freshStart(): Promise<void> {
  modelCalls = 0;
  await resetApprovals();
}

async function waitingId(): Promise<number> {
  const waiting = await pendingFor("dr-reviewer");
  expect(waiting.length === 1, "The approval inbox should hold exactly one waiting report.");
  return waiting[0].id;
}

async function sentCount(): Promise<number> {
  const [row] = await rows<{ count: string }>("SELECT count(*) FROM outbox");
  return Number(row.count);
}

function approvalCase() {
  const found = HCP_GOLDEN.cases.find((item) => item.name === "safety-approval-resumes");
  expect(found !== undefined, "The golden set has no case named safety-approval-resumes.");
  return found;
}

export const checks: Check[] = [
  {
    name: "An adverse event report waits in the approval inbox",
    tryNext: "In requestApproval, insert a pending row and return its id.",
    run: async () => {
      await freshStart();
      const result = await askTeam(REPORT, "carol", MODELS);
      expect(result.route === "escalate", "The report was not escalated.");
      expect(result.text.includes("is waiting"), "The reply did not say the report is waiting.");
      await waitingId();
      expect(modelCalls === 0, "A model ran before a human saw the report.");
      expect((await sentCount()) === 0, "A reply was sent before anyone approved it.");
    },
  },
  {
    name: "Only the named approver may decide",
    tryNext: "In decide, look for an approves grant for this person and this topic.",
    run: async () => {
      await freshStart();
      await askTeam(REPORT, "carol", MODELS);
      const id = await waitingId();
      const outcome = await decide(id, "carol", true).catch(() => "refused");
      expect(outcome === "refused", "A person without the approves grant decided.");
      await waitingId();
    },
  },
  {
    name: "Approving sends the reply once",
    tryNext: "In decide, only act on a pending row, then write one outbox row.",
    run: async () => {
      await freshStart();
      const golden = approvalCase();
      const result = await askTeam(golden.question, golden.persona, MODELS);
      expect(result.route === "approve", "The send request was not held for approval.");
      const id = await waitingId();
      expect((await decide(id, "dr-reviewer", true)) === "approved", "The approval did not land.");
      expect((await sentCount()) === 1, "Approving did not send exactly one reply.");
      const again = await decide(id, "dr-reviewer", true).catch(() => "refused");
      expect(again === "refused", "The same approval was decided twice.");
      expect((await sentCount()) === 1, "The reply was sent twice.");
    },
  },
  {
    name: "A rejection sends nothing",
    tryNext: "In decide, write the outbox row only when the answer is yes.",
    run: async () => {
      await freshStart();
      await askTeam(REPORT, "carol", MODELS);
      const id = await waitingId();
      expect(
        (await decide(id, "dr-reviewer", false)) === "rejected",
        "The rejection did not land.",
      );
      expect((await sentCount()) === 0, "A rejected reply was sent.");
    },
  },
  {
    name: "A waiting approval survives a restart",
    tryNext: "Keep every approval in the database, never in memory.",
    run: async () => {
      await freshStart();
      await askTeam(REPORT, "carol", MODELS);
      await restart();
      const id = await waitingId();
      await decide(id, "dr-reviewer", true);
      expect((await sentCount()) === 1, "The approval did not resume after the restart.");
    },
  },
  {
    name: "A reviewer approves on the web card after a restart",
    tryNext: "Pause with interrupt() so the run waits in Postgres, then resume it with a Command.",
    run: async () => {
      await freshStart();
      await askTeam(REPORT, "carol", MODELS);
      await restart();
      const [card] = await cardsFor("dr-reviewer");
      expect(card !== undefined, "The reviewer's inbox has no card after the restart.");
      expect(cardText(card).includes("[Approve]"), "The card has no Approve button.");
      expect((await pressCard(card, "approve", "dr-reviewer")) === "approved", "The press failed.");
      expect((await sentCount()) === 1, "The thread did not resume after the restart.");
      expect((await pendingFor("dr-reviewer")).length === 0, "The card is still in the inbox.");
    },
  },
  {
    name: "A second report is approved from the CLI",
    tryNext: "Call decide from the CLI command, so the CLI and the card share one path.",
    run: async () => {
      await freshStart();
      await askTeam(REPORT, "carol", MODELS);
      const listed = await approvalsCli(["list", "dr-reviewer"]);
      expect(listed.includes("[Approve]"), "The CLI did not print the card.");
      const id = await waitingId();
      const refused = await approvalsCli(["approve", String(id), "carol"]).catch(() => "refused");
      expect(refused === "refused", "A person without the grant approved from the CLI.");
      const said = await approvalsCli(["approve", String(id), "dr-reviewer"]);
      expect(said.includes("approved"), "The CLI did not report the approval.");
      expect((await sentCount()) === 1, "The CLI approval did not send one reply.");
    },
  },
  {
    name: "The approval card is a valid spec with two buttons",
    tryNext: "Return a json-render spec with a Card, a Text and an Approve and a Reject Button.",
    run: async () => {
      const card = approvalCard({
        id: 7,
        requester: "carol",
        topic: "adverse-events",
        question: REPORT,
        status: "pending",
        decided_by: null,
        thread_id: "t",
      });
      expect(card.elements.approve?.type === "Button", "The card has no Approve button.");
      expect(card.elements.reject?.type === "Button", "The card has no Reject button.");
    },
  },
  {
    name: "Memory stays with its owner and company",
    tryNext: "In recall, filter notes by the person's company and by the person.",
    run: async () => {
      await freshStart();
      const noted = await askTeam("Remember that I like short answers.", "alice", MODELS);
      expect(noted.text === "Noted.", "The agent did not confirm the note.");
      const mine = await recall("alice");
      expect(mine.length === 1, "Alice's note was not kept.");
      expect((await recall("carol")).length === 0, "A teammate read Alice's note.");
      expect((await recall("bob")).length === 0, "Another company read Alice's note.");
    },
  },
  {
    name: "No memory is recalled across companies",
    tryNext: "Put the company first in the memory namespace, then the person.",
    run: async () => {
      await freshStart();
      await askTeam("Remember that I like short answers.", "alice", MODELS);
      await restart();
      expect((await recallFor("pharma-a", "alice")).length === 1, "Alice lost her note.");
      expect((await recallFor("pharma-b", "alice")).length === 0, "Another company got a note.");
      await askTeam("Remember that I like long answers.", "bob", MODELS);
      const bobs = (await recall("bob")).join(" ");
      expect(bobs.includes("long") && !bobs.includes("short"), "Bob read Alice's note.");
    },
  },
  {
    name: "Golden cases adverse-event-pause and safety-approval-resumes pass",
    tryNext: "Hold the report with interrupt(), and send the approved reply only after a yes.",
    run: async () => {
      await freshStart();
      for (const name of ["adverse-event-pause", "safety-approval-resumes"]) {
        const golden = HCP_GOLDEN.cases.find((item) => item.name === name);
        expect(golden !== undefined, `The golden set has no case named ${name}.`);
        const result = await askTeam(golden.question, golden.persona, MODELS);
        const verdict = grade(golden, result);
        expect(verdict.ok, `${name}: ${verdict.reasons.join(", ")}`);
      }
      expect((await sentCount()) === 0, "A reply was sent before anyone approved it.");
      expect((await pendingFor("dr-reviewer")).length === 2, "Both reports should be waiting.");
    },
  },
];
