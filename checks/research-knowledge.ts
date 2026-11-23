// Lab 01: the research teammate reports what moved on a rival page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startMockSite } from "../apps/product-teammates/mock-site/server";
import {
  askResearch,
  capturePage,
  type Extractor,
  type Generate,
  readStrategy,
  replayExtractor,
  STRATEGY_FOLDER,
  snapshotsOf,
  writeTextPdf,
} from "../apps/product-teammates/src/capture";
import { askMission } from "../apps/product-teammates/src/mission";
import { readPage, resetSnapshots } from "../apps/product-teammates/src/research";
import { type RivalSite, siteWorld, startRivalSite } from "../apps/product-teammates/src/rivals";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { rows } from "../packages/core/src/db";
import { resetDocuments } from "../packages/core/src/ingestion";
import { OUTPUT } from "../scripts/seed";
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
    tryNext: "Answer a question that names no rival and no topic with the template reply.",
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

// The capture checks. They replay the recorded extract file, so they need no browser and no key.
const PRICE_QUESTION = "What did Pulsedesk change on its pricing page?";
const WEEK_ONE = { url: "http://replay", week: "week-1" };
const WEEK_TWO = { url: "http://replay", week: "week-2" };
const WEEK_THREE = { url: "http://replay", week: "week-3" };
const DAY_ONE = "2026-11-10";
const DAY_TWO = "2026-11-17";
const DAY_THREE = "2026-11-20";

async function freshSnapshots(): Promise<Extractor> {
  await resetDocuments();
  return replayExtractor();
}

// The first look at last week's page, then this week's question.
async function afterOneWeek(extractor: Extractor, generate?: Generate) {
  const first = { extractor, site: WEEK_ONE, day: DAY_ONE };
  await askResearch(PRICE_QUESTION, first);
  const second = { extractor, site: WEEK_TWO, day: DAY_TWO, generate };
  return askResearch(PRICE_QUESTION, second);
}

async function pricingCount(): Promise<number> {
  return (await snapshotsOf("Pulsedesk", "pricing")).length;
}

export const captureChecks: Check[] = [
  {
    name: "The price change is found: 49 USD became 79 USD",
    tryNext: "In priceMoves, compare each plan price in the old text with the new text.",
    run: async () => {
      const site = startMockSite();
      try {
        site.show("week-1");
        expect((await (await fetch(`${site.url}/pricing`)).text()).includes("49 USD"), "Week 1.");
        site.show("week-2");
        expect((await (await fetch(`${site.url}/pricing`)).text()).includes("79 USD"), "Week 2.");
      } finally {
        site.stop();
      }
      const result = await afterOneWeek(await freshSnapshots());
      expect(result.route === "answer", `The route was ${result.route}, wanted answer.`);
      expect(result.text.includes("49"), "The report lacks the old price, 49 USD.");
      expect(result.text.includes("79"), "The report lacks the new price, 79 USD.");
      expect(result.text.includes("Team"), "The report does not name the Team plan.");
    },
  },
  {
    name: "An unchanged page is skipped, so the snapshot count stays the same",
    tryNext: "In capturePage, call ingestDocument and report unchanged when it skips the file.",
    run: async () => {
      const extractor = await freshSnapshots();
      await afterOneWeek(extractor);
      const before = await pricingCount();
      const again = { extractor, site: WEEK_THREE, day: DAY_THREE };
      const result = await askResearch(PRICE_QUESTION, again);
      expect(result.text.includes("did not change"), `The report was: ${result.text}`);
      expect(before === 2, `Two weeks should give two snapshots, not ${before}.`);
      expect((await pricingCount()) === before, "A page that did not change was saved again.");
      const last = await capturePage(extractor, { ...WEEK_THREE, page: "pricing" }, DAY_THREE);
      expect(last.status === "unchanged", `The status was ${last.status}, wanted unchanged.`);
    },
  },
  {
    name: "Trivia is redirected with no page read",
    tryNext: "In routeByPolicy, return the template route when no word of the policy matches.",
    run: async () => {
      const extractor: Extractor = async () => {
        throw new Error("A trivia question must not read a page.");
      };
      const asks = ["Write me a poem about Mondays.", "What is the capital of France?"];
      for (const question of asks) {
        const result = await askResearch(question, { extractor, site: WEEK_ONE, day: DAY_ONE });
        expect(result.route === "template", `${question} got the route ${result.route}.`);
        expect(result.citations.length === 0, "A redirect cited a page.");
      }
    },
  },
  {
    name: "The answer is cited, and a wrong answer is refused",
    tryNext: "In askResearch, run checkClaim on the reply and refuse when it finds a problem.",
    run: async () => {
      const extractor = await freshSnapshots();
      const good = await afterOneWeek(extractor);
      const names = (await snapshotsOf("Pulsedesk", "pricing")).map((item) => item.slug);
      expect(good.citations.length === 2, `The answer cited ${good.citations.length} snapshots.`);
      expect(
        names.every((name) => good.citations.includes(name)),
        "A citation is not a snapshot.",
      );
      const wrong: Record<string, Generate> = {
        "a price that is not on the page": async () => `Team went from 49 to 59 USD. [${names[0]}]`,
        "no citation": async () => "Team went from 49 to 79 USD.",
        "a snapshot that was never shown": async () =>
          "Team went to 79 USD. [pulsedesk-pricing-0000]",
      };
      for (const [name, generate] of Object.entries(wrong)) {
        const bad = await afterOneWeek(await freshSnapshots(), generate);
        expect(bad.route === "refuse", `An answer with ${name} was accepted.`);
      }
    },
  },
  {
    name: "A strategy PDF is read through xberg",
    tryNext: "In readStrategy, read the PDF with readPdfText so the answer can use its words.",
    run: async () => {
      const source = readFileSync(join(STRATEGY_FOLDER, "pulsedesk-strategy.txt"), "utf8");
      const file = join(OUTPUT, "strategy", "pulsedesk-strategy.pdf");
      await writeTextPdf(file, source.trim());
      const text = await readStrategy(file);
      expect(text.includes("mobile app for on call staff"), "The PDF text was not read.");
    },
  },
];

checks.push(...captureChecks);
