// The catalog is the course. These tests prove it is wide, honest and built as designed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMERCIAL_DISPENSES,
  SUPPLY_DIP_WEEKS,
  TERRITORY_RX_WEEKLY,
  weeklyTotal,
} from "../data/catalog/analytics";
import { BRANDS } from "../data/catalog/brands";
import { DOCUMENTS, stateOf } from "../data/catalog/documents";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import {
  ACTIVATION_DIP_WEEK,
  CHURN_SPIKE_WEEK,
  churnRate,
  PRODUCT_FUNNEL,
} from "../data/catalog/mission-control";
import { PEOPLE } from "../data/catalog/people";
import { PRESCRIBERS, TERRITORIES } from "../data/catalog/prescribers";
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
      for (const intent of ["answer", "refuse", "template", "approve"]) {
        expect(set.cases.some((item) => item.intent === intent)).toBe(true);
      }
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
  test("it asks an escalate case", () => {
    expect(HCP_GOLDEN.cases.some((item) => item.intent === "escalate")).toBe(true);
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
    expect(distinct(DOCUMENTS.map((document) => document.type))).toBe(5);
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

describe("designed patterns exist", () => {
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

describe("seed", () => {
  function fingerprint(): string {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const document of DOCUMENTS) {
      hasher.update(readFileSync(join(OUTPUT, "documents", `${document.slug}.pdf`)));
    }
    hasher.update(readFileSync(join(OUTPUT, "sql", "seed.sql")));
    return hasher.digest("hex");
  }
  test("two runs give the same bytes", async () => {
    await seed();
    const first = fingerprint();
    await seed();
    expect(fingerprint()).toBe(first);
  });
  test("every document has a file and the scan has no text", async () => {
    await seed();
    const scan = readFileSync(
      join(OUTPUT, "documents", "breathe-ez-br-scanned-page.pdf"),
      "latin1",
    );
    expect(scan.includes("Tj")).toBe(false);
    const label = readFileSync(join(OUTPUT, "documents", "oncox-us-label-v2.pdf"), "latin1");
    expect(label.length).toBeGreaterThan(500);
  });
});
