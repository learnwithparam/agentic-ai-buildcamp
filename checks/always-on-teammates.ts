// Lab 04: the teammates run on events and on the Monday clock, and survive a crash.

import {
  drain,
  onEvent,
  PRICE_EVENT,
  resetAlwaysOn,
  rivalsSeen,
  scheduleMonday,
} from "../apps/product-teammates/src/always-on";
import { askMission } from "../apps/product-teammates/src/mission";
import { publishedIn } from "../apps/product-teammates/src/workspace";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { rows } from "../packages/core/src/db";
import { grade } from "../src/grade";
import { type Check, expect } from "../src/verify";

const NO_PAGES = {
  fetchRival: async (): Promise<string> => {
    throw new Error("An always-on question must not read a rival page.");
  },
};
const CORE = "core-growth";
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
      const later = new Date(moment.getTime() + WINDOW_MINUTES * 60 * 1000);
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
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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
      await new Promise((done) => setTimeout(done, 1300));
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
];
