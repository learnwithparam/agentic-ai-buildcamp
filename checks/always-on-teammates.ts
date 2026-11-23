// Lab 04: the teammates run on events and on the Monday clock, and survive a crash.

import {
  approvalCard,
  cardText,
  drain,
  EVENT_QUEUE,
  goldenGate,
  MONDAY_QUEUE,
  onEvent,
  PRICE_EVENT,
  resetAlwaysOn,
  rivalsSeen,
  scheduleMonday,
  sendEvent,
  startBoss,
  stopBoss,
  waitingCard,
  writeBriefing,
} from "../apps/product-teammates/src/always-on";
import { askMission } from "../apps/product-teammates/src/mission";
import { publishedIn } from "../apps/product-teammates/src/workspace";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { rows } from "../packages/core/src/db";
import { gate, gateText } from "../packages/core/src/gate";
import { grade } from "../src/grade";
import { MS_PER_DAY, MS_PER_MINUTE } from "../src/time";
import { type Check, expect } from "../src/verify";

const NO_PAGES = {
  fetchRival: async (): Promise<string> => {
    throw new Error("An always-on question must not read a rival page.");
  },
};
const CORE = "core-growth";
const SETTLE_MS = 1300; // longer than the job lease, so the stopped job counts as lost
const WINDOW_MINUTES = 10;

function caseOf(name: string) {
  const found = MISSION_CONTROL_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

async function askAs(person: string, question: string) {
  return askMission(question, person, NO_PAGES);
}

async function count(sql: string): Promise<number> {
  const [row] = await rows<{ count: string }>(sql);
  return Number(row.count);
}

async function freshRows(): Promise<void> {
  await rows("DROP TABLE IF EXISTS tone_notes, briefings");
  await resetAlwaysOn();
}

export const checks: Check[] = [
  {
    name: "A rival event starts one research run",
    tryNext: "In onEvent, add one job whose key holds the event name, the rival and the window.",
    run: async () => {
      await freshRows();
      const found = caseOf("event-to-run");
      const truth = found.truth as { event: string; runs: number };
      const result = await askAs("priya", found.question);
      expect(grade(found, result).ok, `The event case failed: ${grade(found, result).reasons}`);
      const runs = await count("SELECT count(*) FROM runs WHERE kind = 'research'");
      expect(runs === truth.runs, `Expected ${truth.runs} run, saw ${runs}.`);
      expect(truth.event === PRICE_EVENT, "The event name changed.");
    },
  },
  {
    name: "A crowd of events starts one run, and each rival still gets its own",
    tryNext: "Build the key from the event, the rival and the window, and nothing that changes.",
    run: async () => {
      await freshRows();
      const found = caseOf("debounce");
      const truth = found.truth as { events: number; runs: number };
      const result = await askAs("priya", found.question);
      expect(grade(found, result).ok, `The burst case failed: ${grade(found, result).reasons}`);
      const runs = await count("SELECT count(*) FROM runs");
      expect(runs === truth.runs, `${truth.events} events gave ${runs} runs, not ${truth.runs}.`);
      const moment = new Date();
      await onEvent(PRICE_EVENT, "Tallyfox", moment);
      await onEvent(PRICE_EVENT, "Orbitnote", moment);
      await drain();
      expect((await rivalsSeen()).length === 3, "Each rival must get its own run.");
      const later = new Date(moment.getTime() + WINDOW_MINUTES * MS_PER_MINUTE);
      expect(await onEvent(PRICE_EVENT, "Tallyfox", later), "A later window got no new run.");
    },
  },
  {
    name: "The Monday clock drafts one briefing per week and waits for an approver",
    tryNext: "In scheduleMonday, key the job on the Monday date, then draft from the rivals seen.",
    run: async () => {
      await freshRows();
      await onEvent(PRICE_EVENT, "Pulsedesk", new Date());
      await drain();
      const found = caseOf("monday-briefing");
      const result = await askAs("lena", found.question);
      expect(grade(found, result).ok, `The Monday case failed: ${grade(found, result).reasons}`);
      await askAs("lena", found.question);
      const drafts = "SELECT count(*) FROM briefings WHERE status = 'pending'";
      expect((await count(drafts)) === 1, "The same week was drafted twice.");
      const [draft] = await rows<{ body: string }>("SELECT body FROM briefings");
      expect(draft.body.includes("Pulsedesk"), "The briefing does not name the rival that moved.");
      const nextWeek = new Date(Date.now() + 7 * MS_PER_DAY);
      expect(await scheduleMonday(nextWeek, CORE), "Next week got no briefing job.");
    },
  },
  {
    name: "A server killed halfway resumes and drafts exactly once",
    tryNext: "Save the draft and the step in one transaction, and return early when the step is 1.",
    run: async () => {
      await freshRows();
      await onEvent(PRICE_EVENT, "Pulsedesk", new Date());
      await drain();
      await scheduleMonday(new Date(), CORE);
      const child = Bun.spawn(["bun", "scripts/briefing-crash-worker.ts"], { stdout: "ignore" });
      await child.exited;
      const stopped = "SELECT count(*) FROM jobs WHERE status = 'running' AND step = 1";
      expect((await count(stopped)) === 1, "The crash left no saved step.");
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      const found = caseOf("crash-resume");
      const result = await askAs("lena", found.question);
      expect(grade(found, result).ok, `The resume case failed: ${grade(found, result).reasons}`);
      expect(
        (await count("SELECT count(*) FROM briefings")) === 1,
        "A briefing was drafted twice.",
      );
      expect((await count("SELECT count(*) FROM jobs WHERE status = 'done'")) === 2, "Not done.");
    },
  },
  {
    name: "Only an approver publishes the briefing to the team",
    tryNext: "In approveAnswer, find the waiting briefing and call approveBriefing for the asker.",
    run: async () => {
      await freshRows();
      await onEvent(PRICE_EVENT, "Pulsedesk", new Date());
      await scheduleMonday(new Date(), CORE);
      await drain();
      const found = caseOf("publish-approval");
      const writer = await askAs("priya", found.question);
      expect(writer.route === "refuse", "A person without the approves grant published.");
      expect((await publishedIn(CORE)).length === 0, "The briefing went out too early.");
      const result = await askAs("lena", found.question);
      expect(grade(found, result).ok, `The publish case failed: ${grade(found, result).reasons}`);
      const published = await publishedIn(CORE);
      expect(published.length === 1, "The briefing was not published.");
      expect(published[0].includes("Pulsedesk"), "The published briefing lost its rival.");
    },
  },
  {
    name: "An event runs, the briefing pauses, and the card carries it to the web and the CLI",
    tryNext: "Build the card from the waiting briefing. Give it a digest, a post and two actions.",
    run: async () => {
      await freshRows();
      await onEvent(PRICE_EVENT, "Pulsedesk", new Date());
      await scheduleMonday(new Date(), CORE);
      await drain();
      const card = await waitingCard(CORE);
      expect(card !== undefined, "The run did not pause on a waiting briefing.");
      expect(card.type === "ApprovalCard", "The spec is not an ApprovalCard.");
      expect(card.props.digest.includes("Pulsedesk"), "The digest lacks the rival.");
      expect(card.props.post.length > 0 && card.props.post.length <= 280, "The post is not short.");
      const ids = card.actions.map((action) => action.id).join(",");
      expect(ids === "approve,reject", `The card actions were ${ids}.`);
      const text = cardText(card);
      expect(text.includes(card.props.post), "The CLI text lacks the post.");
      expect(text.includes("1. Approve and publish"), "The CLI text lacks the approve choice.");
      expect(
        approvalCard(7, `${card.props.digest}\n---\nlinkedin: Hello`).props.channel === "linkedin",
        "A LinkedIn post lost its channel.",
      );
      await askAs("lena", "Approve the Pulsedesk briefing and publish it to the team.");
      expect((await waitingCard(CORE)) === undefined, "A card stayed after the approval.");
    },
  },
  {
    name: "pg-boss schedules Monday 09:00 and holds ten events as one job",
    tryNext: "Send each event with a singletonKey built from the event, the rival and the window.",
    run: async () => {
      const boss = await startBoss(CORE);
      try {
        const [timer] = await boss.getSchedules(MONDAY_QUEUE);
        expect(
          timer?.cron === "0 9 * * 1",
          "The Monday schedule is not saved at 09:00 on pg-boss.",
        );
        const moment = new Date();
        const sent: boolean[] = [];
        for (let event = 0; event < 10; event += 1)
          sent.push(await sendEvent(boss, "Pulsedesk", moment));
        expect(sent.filter(Boolean).length === 1, "Ten events made more than one pg-boss job.");
        sent.push(await sendEvent(boss, "Tallyfox", moment));
        expect(sent[10], "A second rival was dropped by the debounce.");
        const waiting = await boss.fetch(EVENT_QUEUE, { batchSize: 20 });
        expect(waiting.length === 2, `pg-boss held ${waiting.length} jobs, not 2.`);
      } finally {
        await stopBoss(boss);
      }
    },
  },
  {
    name: "The briefing agent writes a digest and a short post",
    tryNext: "In writeBriefing, name every rival in the digest and cut the post to 280 characters.",
    run: async () => {
      const draft = writeBriefing(["Pulsedesk", "Tallyfox"], "linkedin");
      expect(
        draft.digest.includes("Pulsedesk") && draft.digest.includes("Tallyfox"),
        "Rival lost.",
      );
      expect(draft.post.includes("Tallyfox"), "The post lacks the rivals.");
      expect(draft.channel === "linkedin", "The channel was not kept.");
      const quiet = writeBriefing([]);
      expect(quiet.digest.includes("No rival changed"), "A quiet week was not said plainly.");
    },
  },
  {
    name: "All 24 golden cases pass on replay, and a planted wrong answer closes the gate",
    tryNext: "Fix the case named in the gate report. Do not edit the golden set.",
    run: async () => {
      const result = await goldenGate();
      expect(result.open && result.passed === 24, gateText(result));
      const grades = Array.from({ length: 24 }, () => ({ ok: true, reasons: [] as string[] }));
      grades[20] = { ok: false, reasons: ["planted wrong answer"] };
      const closed = gate(MISSION_CONTROL_GOLDEN, grades);
      expect(
        !closed.open && closed.failures.length === 1,
        "A wrong answer did not close the gate.",
      );
      expect(gateText(closed).includes(MISSION_CONTROL_GOLDEN.cases[20].name), "No case named.");
    },
  },
];
