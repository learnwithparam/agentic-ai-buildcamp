// The numbers behind the BI questions. Each series has a designed pattern.
// So every answer has a reason.
//
//   OncoX        launches in March 2026 and ramps up
//   CardioZ      sells more in winter, and the Great Lakes ran out of stock for four weeks in June
//   Breathe-EZ   peaks in the pollen weeks of spring, and Texas Triangle had one big event week
//   DermaClear   dips in summer
//   NeuroCalm    grows every month, and its price rose in July
//
// The two tenants keep their data in different shapes on purpose: weekly and monthly, with
// different column names. The agent must discover each shape, never assume it.

import { TERRITORIES } from "./prescribers";

const HCP_SALES_SEED = 20261121;
const HCP_WEEKS_SEED = 20261120;
const WEST_BASE_UNITS = 1400;
const OTHER_BASE_UNITS = 1000;

import { addDays, noiseAround, seededRandom } from "./random";

export type WeeklyRow = {
  territory: string;
  brand: string;
  week_start: string;
  new_prescriptions: number;
  total_prescriptions: number;
};

export type MonthlyRow = {
  region: string;
  product: string;
  month: string;
  units_dispensed: number;
  net_sales_usd: number;
};

export const FIRST_WEEK = "2025-11-24";
export const WEEK_COUNT = 52;
export const SUPPLY_DIP_WEEKS = ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];
export const EVENT_WEEK = "2026-04-20";

const SIZES: [territory: string, size: number][] = [
  ["Pacific Northwest", 0.8],
  ["Great Lakes", 1.1],
  ["Texas Triangle", 1.3],
  ["Mid-Atlantic", 1.2],
  ["New England", 0.7],
  ["Florida Gulf", 1.0],
  ["Rocky Mountain", 0.6],
  ["Southern California", 1.4],
];

function sizeOf(territory: string): number {
  return SIZES.find(([name]) => name === territory)?.[1] ?? 1;
}

function seasonFor(brand: string, week: number): number {
  if (brand === "CardioZ") return 1 + 0.25 * Math.cos((2 * Math.PI * (week + 4)) / 52);
  if (brand === "Breathe-EZ") return 1 + 0.6 * Math.exp(-(((week - 22) / 4) ** 2));
  const launchWeek = 16;
  return (1 / (1 + Math.exp(-(week - launchWeek - 10) / 4))) * (week >= launchWeek ? 1 : 0);
}

function level(brand: string): number {
  if (brand === "OncoX") return 30;
  return brand === "CardioZ" ? 90 : 60;
}

function patternFor(territory: string, brand: string, weekStart: string): number {
  const dip =
    territory === "Great Lakes" && brand === "CardioZ" && SUPPLY_DIP_WEEKS.includes(weekStart);
  if (dip) return 0.08;
  const event =
    territory === "Texas Triangle" && brand === "Breathe-EZ" && weekStart === EVENT_WEEK;
  return event ? 3 : 1;
}

function buildWeekly(): WeeklyRow[] {
  const random = seededRandom(HCP_WEEKS_SEED);
  const rows: WeeklyRow[] = [];
  for (const brand of ["OncoX", "CardioZ", "Breathe-EZ"]) {
    for (const territory of TERRITORIES) {
      for (let week = 0; week < WEEK_COUNT; week++) {
        const weekStart = addDays(FIRST_WEEK, week * 7);
        const shape = seasonFor(brand, week) * patternFor(territory, brand, weekStart);
        const fresh = Math.round(
          level(brand) * sizeOf(territory) * shape * noiseAround(random, 0.06),
        );
        const total = Math.round(fresh * 3.2 * noiseAround(random, 0.03));
        rows.push({
          territory,
          brand,
          week_start: weekStart,
          new_prescriptions: fresh,
          total_prescriptions: total,
        });
      }
    }
  }
  return rows;
}

export const TERRITORY_RX_WEEKLY: WeeklyRow[] = buildWeekly();

const REGIONS = ["Northeast", "Southeast", "Midwest", "West"];
const MONTHS = [
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
];

function monthlyShape(product: string, month: string, step: number): number {
  if (product === "DermaClear") return ["2026-06", "2026-07", "2026-08"].includes(month) ? 0.7 : 1;
  return 1 + 0.04 * step;
}

function unitPrice(product: string, month: string): number {
  if (product === "DermaClear") return 24;
  return month >= "2026-07" ? 44 : 38;
}

function buildMonthly(): MonthlyRow[] {
  const random = seededRandom(HCP_SALES_SEED);
  const rows: MonthlyRow[] = [];
  for (const product of ["DermaClear", "NeuroCalm"]) {
    for (const region of REGIONS) {
      MONTHS.forEach((month, step) => {
        const base = region === "West" ? WEST_BASE_UNITS : OTHER_BASE_UNITS;
        const units = Math.round(
          base * monthlyShape(product, month, step) * noiseAround(random, 0.04),
        );
        rows.push({
          region,
          product,
          month,
          units_dispensed: units,
          net_sales_usd: units * unitPrice(product, month),
        });
      });
    }
  }
  return rows;
}

export const COMMERCIAL_DISPENSES: MonthlyRow[] = buildMonthly();

// Questions the golden cases ask, answered from the rows. The truth never comes from a model.
export function weeklyTotal(
  brand: string,
  territory: string,
  firstWeek: string,
  lastWeek: string,
): number {
  return TERRITORY_RX_WEEKLY.filter((row) => {
    const sameSeries = row.brand === brand && row.territory === territory;
    return sameSeries && row.week_start >= firstWeek && row.week_start <= lastWeek;
  }).reduce((sum, row) => sum + row.new_prescriptions, 0);
}

export function topTerritory(brand: string, firstWeek: string, lastWeek: string): string {
  const totals = TERRITORIES.map((name) => ({
    name,
    total: weeklyTotal(brand, name, firstWeek, lastWeek),
  }));
  totals.sort((first, second) => second.total - first.total);
  return totals[0].name;
}

export function monthlySales(product: string, month: string): number {
  return COMMERCIAL_DISPENSES.filter(
    (row) => row.product === product && row.month === month,
  ).reduce((sum, row) => sum + row.net_sales_usd, 0);
}
