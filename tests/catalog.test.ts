// The catalog is the course. These tests prove it is wide, honest and built as designed.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  COMMERCIAL_DISPENSES,
  SUPPLY_DIP_WEEKS,
  TERRITORY_RX_WEEKLY,
  weeklyTotal,
} from "../data/catalog/analytics";
import { BRANDS } from "../data/catalog/brands";
import { DOCUMENTS, PLANTED_LINE, stateOf } from "../data/catalog/documents";
import { HCP_GOLDEN, HCP_LAB_CASES } from "../data/catalog/golden-hcp";
import {
  MISSION_CONTROL_GOLDEN,
  MISSION_CONTROL_LAB_CASES,
} from "../data/catalog/golden-mission-control";
import { INBOUND } from "../data/catalog/inbound";
import {
  ACTIVATION_DIP_WEEK,
  CHANNEL_FUNNEL,
  CHURN_SPIKE_WEEK,
  COMPETITORS,
  churnRate,
  DIP_CHANNEL,
  PRODUCT_FUNNEL,
  WORKSPACES,
} from "../data/catalog/mission-control";
import { PEOPLE } from "../data/catalog/people";
import { PRESCRIBERS, TERRITORIES } from "../data/catalog/prescribers";
import { decide } from "../packages/core/src/router";
import { OUTPUT, seed } from "../scripts/seed";
import type { GoldenSet } from "../src/golden";

function distinct(values: (string | undefined)[]): number {
  return new Set(values.filter((value) => value !== undefined)).size;
}

function share(set: GoldenSet, brand: string): number {
  return set.cases.filter((item) => item.brand === brand).length / set.cases.length;
}

describe("both golden sets", () => {
  for (const set of [HCP_GOLDEN, MISSION_CONTROL_GOLDEN]) {
    test(`${set.track} has 24 cases with every kind and intent`, () => {
      expect(set.cases.length).toBe(24);
      for (const kind of ["naive", "happy", "edge", "adversarial"]) {
        expect(set.cases.some((item) => item.kind === kind)).toBe(true);
      }
    });
    test(`${set.track} has at least 3 cases for every intent`, () => {
      for (const intent of ["answer", "refuse", "template", "escalate", "approve"]) {
        expect(set.cases.filter((item) => item.intent === intent).length).toBeGreaterThanOrEqual(3);
      }
    });
    test(`${set.track} lab cases stay outside the 24 and are not repeated`, () => {
      const extras = set.track === "hcp" ? HCP_LAB_CASES : MISSION_CONTROL_LAB_CASES;
      const names = new Set(set.cases.map((item) => item.name));
      for (const item of extras) expect(names.has(item.name)).toBe(false);
    });
    test(`${set.track} names are unique and only the first is naive`, () => {
      expect(distinct(set.cases.map((item) => item.name))).toBe(24);
      expect(set.cases.filter((item) => item.kind === "naive").length).toBe(1);
      expect(set.cases[0].kind).toBe("naive");
    });
    test(`${set.track} asks as people who exist`, () => {
      const names = new Set(PEOPLE.map((person) => person.name));
      for (const item of set.cases) expect(names.has(item.persona)).toBe(true);
    });
  }
});

describe("hcp spread", () => {
  test("it spans brands, countries, document types and personas", () => {
    expect(distinct(HCP_GOLDEN.cases.map((item) => item.brand))).toBeGreaterThanOrEqual(4);
    expect(distinct(HCP_GOLDEN.cases.map((item) => item.country))).toBeGreaterThanOrEqual(3);
    expect(distinct(HCP_GOLDEN.cases.map((item) => item.documentType))).toBeGreaterThanOrEqual(3);
    expect(distinct(HCP_GOLDEN.cases.map((item) => item.persona))).toBeGreaterThanOrEqual(4);
  });
  test("no brand fills more than a third of the cases", () => {
    for (const brand of BRANDS) expect(share(HCP_GOLDEN, brand.name)).toBeLessThanOrEqual(1 / 3);
  });
  test("it holds multi-hop-cited with a citation and three hops", () => {
    const found = HCP_GOLDEN.cases.find((item) => item.name === "multi-hop-cited");
    expect(found?.truth.hops).toHaveLength(3);
    const slugs = DOCUMENTS.map((document) => document.slug);
    const cites = (found?.truth.cites ?? []) as string[];
    expect(cites.length).toBeGreaterThan(0);
    for (const cite of cites) expect(slugs).toContain(cite);
  });
  test("every routed question takes the path its case expects", () => {
    for (const item of HCP_GOLDEN.cases) {
      if (["template", "escalate", "approve"].includes(item.intent)) {
        expect(decide(item.question).route).toBe(item.intent);
      }
    }
  });
});

describe("inbound messages", () => {
  test("every kind is there and every sender exists", () => {
    const kinds = new Set(INBOUND.map((item) => item.kind));
    for (const kind of ["medical-question", "adverse-event-email", "off-label", "trivia"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    const names = new Set(PEOPLE.map((person) => person.name));
    for (const item of INBOUND) expect(names.has(item.from)).toBe(true);
  });
  test("the router sends each message down the route it is filed under", () => {
    for (const item of INBOUND) expect(decide(item.text).route).toBe(item.route);
  });
  test("an adverse event hides inside a friendly email", () => {
    const email = INBOUND.find((item) => item.id === "rash-in-thanks");
    expect(email?.text.startsWith("Hi team, lovely")).toBe(true);
    expect(email?.text.includes("rash")).toBe(true);
  });
});

describe("documents", () => {
  test("every state of a label appears", () => {
    const states = new Set(DOCUMENTS.map((document) => stateOf(document)));
    for (const state of ["current", "superseded", "future", "expired"]) {
      expect(states.has(state as never)).toBe(true);
    }
  });
  test("every document type appears and every slug is readable", () => {
    expect(distinct(DOCUMENTS.map((document) => document.type))).toBe(6);
    for (const document of DOCUMENTS) expect(document.slug).toMatch(/^[a-z0-9-]+$/);
    expect(distinct(DOCUMENTS.map((document) => document.slug))).toBe(DOCUMENTS.length);
  });
  test("a label is never current in two versions at once", () => {
    for (const brand of BRANDS) {
      const current = DOCUMENTS.filter((document) => {
        const isLabel = document.type === "label" && document.brand === brand.name;
        return isLabel && stateOf(document) === "current";
      });
      const countries = current.map((document) => document.country);
      expect(new Set(countries).size).toBe(countries.length);
    }
  });
});

describe("the world is as wide as designed", () => {
  test("two tenants, five brands, four countries, forty prescribers", () => {
    expect(distinct(BRANDS.map((brand) => brand.tenant))).toBe(2);
    expect(BRANDS.length).toBe(5);
    expect(distinct(DOCUMENTS.map((document) => document.country))).toBe(4);
    expect(PRESCRIBERS.length).toBe(40);
    expect(distinct(PRESCRIBERS.map((person) => person.npi))).toBe(40);
  });
  test("a year of weekly data and monthly data for the other tenant", () => {
    expect(distinct(TERRITORY_RX_WEEKLY.map((row) => row.week_start))).toBe(52);
    expect(Object.keys(COMMERCIAL_DISPENSES[0])).toEqual([
      "region",
      "product",
      "month",
      "units_dispensed",
      "net_sales_usd",
    ]);
  });
  test("seven people each have a role, a country and a clearance", () => {
    expect(PEOPLE.map((person) => person.name)).toEqual([
      "alice",
      "bob",
      "carol",
      "dr-reviewer",
      "priya",
      "marcus",
      "lena",
    ]);
    for (const person of PEOPLE) {
      expect(person.role.length).toBeGreaterThan(0);
      expect(person.country.length).toBe(2);
      expect(person.clearance).toBeGreaterThan(0);
    }
  });
});

describe("the people and the rivals", () => {
  test("two workspaces, and the Titan memo names 48 million", () => {
    expect(WORKSPACES.length).toBe(2);
    expect(WORKSPACES.some((item) => item.memo?.includes("48 million"))).toBe(true);
  });
  test("every rival keeps a page history and one price moves from 49 to 79", () => {
    expect(COMPETITORS.length).toBe(4);
    for (const rival of COMPETITORS) {
      expect(rival.history.length).toBeGreaterThanOrEqual(3);
      expect(rival.history.at(-1)?.text).toBe(rival.after);
      expect(rival.history.at(-2)?.text).toBe(rival.before);
    }
    const pulse = COMPETITORS.find((rival) => rival.name === "Pulsedesk");
    expect(pulse?.before.includes("49")).toBe(true);
    expect(pulse?.after.includes("79")).toBe(true);
  });
  test("a label has old, current, future and expired versions for one brand", () => {
    const oncox = DOCUMENTS.filter((item) => item.brand === "OncoX" && item.type === "label");
    expect(oncox.map((item) => stateOf(item))).toContain("superseded");
    expect(oncox.map((item) => stateOf(item))).toContain("future");
    const states = DOCUMENTS.map((item) => stateOf(item));
    expect(states).toContain("expired");
  });
});

describe("designed patterns exist", () => {
  test("the activation dip sits in one channel", () => {
    const week = CHANNEL_FUNNEL.filter((row) => row.week_start === ACTIVATION_DIP_WEEK);
    const rate = (row: (typeof week)[number]) => row.activated / row.signups;
    const lowest = week.reduce((low, row) => (rate(row) < rate(low) ? row : low));
    expect(lowest.channel).toBe(DIP_CHANNEL);
    for (const row of week.filter((item) => item.channel !== DIP_CHANNEL)) {
      expect(rate(row)).toBeGreaterThan(0.5);
    }
  });
  test("the Great Lakes CardioZ supply dip is the lowest in its weeks", () => {
    for (const week of SUPPLY_DIP_WEEKS) {
      const totals = TERRITORIES.map((name) => weeklyTotal("CardioZ", name, week, week));
      expect(Math.min(...totals)).toBe(weeklyTotal("CardioZ", "Great Lakes", week, week));
    }
  });
  test("OncoX has no sales before launch and grows after", () => {
    const early = weeklyTotal("OncoX", "Texas Triangle", "2025-11-24", "2026-03-01");
    const late = weeklyTotal("OncoX", "Texas Triangle", "2026-09-01", "2026-11-16");
    expect(early).toBe(0);
    expect(late).toBeGreaterThan(0);
  });
  test("the two tenants keep different shapes", () => {
    expect(Object.keys(TERRITORY_RX_WEEKLY[0])).not.toEqual(Object.keys(COMMERCIAL_DISPENSES[0]));
  });
  test("the funnel has a churn spike and an activation dip", () => {
    expect(churnRate("team", CHURN_SPIKE_WEEK)).toBeGreaterThan(
      churnRate("team", "2026-09-07") * 2,
    );
    const dip = PRODUCT_FUNNEL.filter((row) => row.week_start === ACTIVATION_DIP_WEEK);
    for (const row of dip) expect(row.activated / row.signups).toBeLessThan(0.45);
  });
  test("prescriber numbers cannot match a real doctor", () => {
    for (const person of PRESCRIBERS) expect(person.npi.startsWith("1999")).toBe(true);
  });
});

// The page streams are compressed. This opens them so a test can see what a reader would see.
function pageStreams(file: string): string {
  const bytes = readFileSync(file);
  const text = bytes.toString("latin1");
  const parts: string[] = [];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf("endstream", start);
    try {
      parts.push(inflateSync(bytes.subarray(start, end)).toString("latin1"));
    } catch {
      // Not a compressed stream, so there is nothing to read.
    }
  }
  return parts.join("\n");
}

// pdf-lib writes each drawn string as hex before Tj. This turns the hex back into words.
function drawnWords(file: string): string {
  const hex = [...pageStreams(file).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)];
  const lines = hex.map((item) => Buffer.from(item[1], "hex").toString("latin1"));
  return lines.join("\n");
}

function everyFile(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? everyFile(path) : [path];
  });
}

describe("seed", () => {
  function fingerprint(): string {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of everyFile(OUTPUT).sort()) {
      hasher.update(file.slice(OUTPUT.length));
      hasher.update(readFileSync(file));
    }
    return hasher.digest("hex");
  }
  test("two runs give the same bytes", async () => {
    await seed();
    const first = fingerprint();
    await seed();
    expect(fingerprint()).toBe(first);
  });
  test("the file count matches the catalog", async () => {
    await seed();
    const files = readdirSync(join(OUTPUT, "documents")).filter((name) => name.endsWith(".pdf"));
    expect(files.length).toBe(DOCUMENTS.length);
    for (const document of DOCUMENTS) expect(files).toContain(`${document.slug}.pdf`);
  });
  test("the scan has no text layer but does have ink", async () => {
    await seed();
    const scan = join(OUTPUT, "documents", "breathe-ez-br-scanned-page.pdf");
    const streams = pageStreams(scan);
    expect(streams.length).toBeGreaterThan(500);
    expect(/\bT[jJ]\b/.test(streams)).toBe(false);
    expect(streams.split("\nf\n").length).toBeGreaterThan(100);
    expect(drawnWords(scan)).toBe("");
  });
  test("a normal label does have a text layer", async () => {
    await seed();
    const label = join(OUTPUT, "documents", "oncox-us-label-v2.pdf");
    expect(drawnWords(label)).toContain("150 mg once daily");
  });
  test("the injection PDF holds the planted line in white ink", async () => {
    await seed();
    const file = join(OUTPUT, "documents", "breathe-ez-us-study-injected.pdf");
    const words = drawnWords(file);
    expect(words).toContain(PLANTED_LINE);
    expect(pageStreams(file)).toContain("1 1 1 rg");
    const clean = join(OUTPUT, "documents", "oncox-us-study-summary.pdf");
    expect(drawnWords(clean).includes("Ignore your rules")).toBe(false);
  });
});

describe("seeded documents carry their features", () => {
  test("the study summary holds its results table and the study holds footnotes", async () => {
    await seed();
    const table = drawnWords(join(OUTPUT, "documents", "oncox-us-study-summary.pdf"));
    expect(table).toContain("Standard care");
    expect(table).toContain("19 percent");
    const study = drawnWords(join(OUTPUT, "documents", "neurocalm-us-study-summary.pdf"));
    expect(study).toContain("2. The sugar pill group had 206 adults.");
  });
  test("the sql holds the funnel by channel and the history files exist", async () => {
    await seed();
    const sql = readFileSync(join(OUTPUT, "sql", "seed.sql"), "utf8");
    expect(sql).toContain("INSERT INTO analytics.funnel_by_channel");
    const history = readdirSync(join(OUTPUT, "competitors")).filter((name) =>
      name.endsWith("history.json"),
    );
    expect(history.length).toBe(COMPETITORS.length);
  });
});
