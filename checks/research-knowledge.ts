// Lab 01: the research teammate reports what moved on a rival page.

import { askMission } from "../apps/product-teammates/src/mission";
import { readPage, resetSnapshots } from "../apps/product-teammates/src/research";
import { type RivalSite, siteWorld, startRivalSite } from "../apps/product-teammates/src/rivals";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { rows } from "../packages/core/src/db";
import { grade } from "../src/grade";
import { type Check, expect } from "../src/verify";

function caseOf(name: string) {
  const found = MISSION_CONTROL_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

// Runs the work with the local rival site up and no snapshots saved.
async function withSite(work: (site: RivalSite) => Promise<void>): Promise<void> {
  await resetSnapshots();
  const site = startRivalSite();
  try {
    await work(site);
  } finally {
    site.stop();
  }
}

// Look at a rival last week, then again this week. Returns this week's answer.
async function twoWeeks(site: RivalSite, question: string) {
  const world = siteWorld(site.url);
  site.show("before");
  await askMission(question, "priya", world);
  site.show("after");
  return askMission(question, "priya", world);
}

const RIVAL_CASES: [string, string][] = [
  ["price-swap", "Pulsedesk"],
  ["rival-renamed-plan", "Tallyfox"],
  ["rival-feature-removed", "Orbitnote"],
  ["rival-unchanged", "Lumenboard"],
];

export const checks: Check[] = [
  {
    name: "A rival price change is reported with the old and the new price",
    tryNext: "In watchRival, compare the new text with the last snapshot and keep both.",
    run: async () => {
      await withSite(async (site) => {
        const found = caseOf("price-swap");
        const result = await twoWeeks(site, found.question);
        expect(grade(found, result).ok, `The price case failed: ${grade(found, result).reasons}`);
        expect(result.text.includes("49 dollars"), "The report lacks the old price.");
        expect(result.text.includes("79 dollars"), "The report lacks the new price.");
      });
    },
  },
  {
    name: "Every rival gets its own true report",
    tryNext: "Say changed only when the page text changed, and say did not change otherwise.",
    run: async () => {
      for (const [name, rival] of RIVAL_CASES) {
        await withSite(async (site) => {
          const found = caseOf(name);
          const result = await twoWeeks(site, found.question);
          expect(grade(found, result).ok, `${name} failed: ${grade(found, result).reasons}`);
          const moved = rival !== "Lumenboard";
          expect(result.text.includes("did not change") !== moved, `${rival} was misreported.`);
        });
      }
    },
  },
  {
    name: "A page that did not change is left alone",
    tryNext: "In watchRival, save a snapshot only when the hash differs from the last one.",
    run: async () => {
      await withSite(async (site) => {
        const found = caseOf("unchanged-page-skipped");
        const result = await twoWeeks(site, found.question);
        expect(result.text.includes("did not change"), "An unchanged page was reported.");
        const [row] = await rows<{ count: string }>(
          "SELECT count(*) FROM rival_snapshots WHERE rival = 'Lumenboard'",
        );
        expect(Number(row.count) === 1, "The same page was saved twice.");
      });
    },
  },
  {
    name: "A cookie banner and scripts never reach the report",
    tryNext: "In readPage, cut script, style and the cookie banner before you strip the tags.",
    run: async () => {
      await withSite(async (site) => {
        const found = caseOf("cookie-wall");
        const result = await twoWeeks(site, found.question);
        expect(!result.text.includes("We use cookies"), "The cookie banner is in the report.");
        expect(!result.text.includes("track("), "Script code is in the report.");
        expect(result.text.includes("Scale"), "The new plan name Scale is missing.");
        expect(readPage('<div id="cookie-banner">Hi</div><p>Plans</p>') === "Plans", "Bad clean.");
      });
    },
  },
  {
    name: "Text in a closed tab is still read",
    tryNext: "In readPage, strip tags but keep the text inside hidden sections.",
    run: async () => {
      await withSite(async (site) => {
        const found = caseOf("hidden-price-tabs");
        const result = await twoWeeks(site, found.question);
        expect(
          result.text.includes("90 dollars a year"),
          "The yearly price in the tab is missing.",
        );
        expect(result.text.includes("no longer includes guest access"), "The cut is missing.");
      });
    },
  },
  {
    name: "A question outside the job gets a plain reply with no page read",
    tryNext: "In decideMission, send a question that names no rival and no topic to template.",
    run: async () => {
      await withSite(async () => {
        const found = caseOf("trivia-redirected");
        const world = {
          fetchRival: async () => {
            throw new Error("A trivia question must not read a page.");
          },
        };
        const result = await askMission(found.question, "priya", world);
        expect(grade(found, result).ok, `The trivia case failed: ${grade(found, result).reasons}`);
      });
    },
  },
];
