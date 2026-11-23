// The Mission Control world: one invented software company, Brightloop, with two workspaces.
// The funnel table carries two designed patterns, a churn spike and an activation dip.
// Four rival pages each change in a different way, so the research agent never sees one easy diff.
import { addDays, noiseAround, seededRandom } from "./random";

const MISSION_SEED = 20261122;

export type Workspace = { name: string; about: string; memo?: string };

export const WORKSPACES: Workspace[] = [
  { name: "core-growth", about: "Signups, activation and pricing for the main product." },
  {
    name: "enterprise-stealth",
    about: "Project Titan, a large deal still under wraps.",
    memo: "Project Titan memo: a 48 million dollar deal with a bank, not yet announced.",
  },
];

export type FunnelRow = {
  week_start: string;
  plan: string;
  signups: number;
  activated: number;
  churned: number;
};

export const FUNNEL_FIRST_WEEK = "2026-06-01";
export const CHURN_SPIKE_WEEK = "2026-09-14";
export const ACTIVATION_DIP_WEEK = "2026-08-03";
const PLANS = ["free", "team", "business"];
const BASE_SIGNUPS: Record<string, number> = { free: 400, team: 120, business: 40 };

function funnelFor(plan: string, week: number, weekStart: string, random: () => number): FunnelRow {
  const base = BASE_SIGNUPS[plan] ?? 40;
  const signups = Math.round(base * (1 + 0.02 * week) * noiseAround(random, 0.05));
  const dip = weekStart === ACTIVATION_DIP_WEEK ? 0.55 : 1;
  const activated = Math.round(signups * 0.6 * dip * noiseAround(random, 0.03));
  const spike = plan === "team" && weekStart === CHURN_SPIKE_WEEK ? 4 : 1;
  const churned = Math.round(signups * 0.04 * spike * noiseAround(random, 0.05));
  return { week_start: weekStart, plan, signups, activated, churned };
}

function buildFunnel(): FunnelRow[] {
  const random = seededRandom(MISSION_SEED);
  const rows: FunnelRow[] = [];
  for (let week = 0; week < 20; week++) {
    const weekStart = addDays(FUNNEL_FIRST_WEEK, week * 7);
    for (const plan of PLANS) rows.push(funnelFor(plan, week, weekStart, random));
  }
  return rows;
}

export const PRODUCT_FUNNEL: FunnelRow[] = buildFunnel();

export function churnRate(plan: string, weekStart: string): number {
  const row = PRODUCT_FUNNEL.find((item) => item.plan === plan && item.week_start === weekStart);
  if (row === undefined) throw new Error(`No funnel row for ${plan} on ${weekStart}.`);
  return row.churned / row.signups;
}

// The same funnel by channel. The August dip sits in paid ads, so a total hides where it came from.
export type ChannelRow = {
  week_start: string;
  channel: string;
  signups: number;
  activated: number;
};

export const CHANNELS = ["organic", "paid", "partner"];
export const DIP_CHANNEL = "paid";
const CHANNEL_SHARE: Record<string, number> = { organic: 0.5, paid: 0.3, partner: 0.2 };
const CHANNEL_SEED = 20261123;

function buildChannelFunnel(): ChannelRow[] {
  const random = seededRandom(CHANNEL_SEED);
  const rows: ChannelRow[] = [];
  const weeks = [...new Set(PRODUCT_FUNNEL.map((row) => row.week_start))];
  for (const weekStart of weeks) {
    const total = PRODUCT_FUNNEL.filter((row) => row.week_start === weekStart).reduce(
      (sum, row) => sum + row.signups,
      0,
    );
    for (const channel of CHANNELS) {
      const signups = Math.round(total * CHANNEL_SHARE[channel]);
      const dip = channel === DIP_CHANNEL && weekStart === ACTIVATION_DIP_WEEK ? 0.3 : 1;
      const activated = Math.round(signups * 0.6 * dip * noiseAround(random, 0.03));
      rows.push({ week_start: weekStart, channel, signups, activated });
    }
  }
  return rows;
}

export const CHANNEL_FUNNEL: ChannelRow[] = buildChannelFunnel();

export function channelActivation(channel: string, weekStart: string): number {
  const row = CHANNEL_FUNNEL.find(
    (item) => item.channel === channel && item.week_start === weekStart,
  );
  if (row === undefined) throw new Error(`No channel row for ${channel} on ${weekStart}.`);
  return Number((row.activated / row.signups).toFixed(3));
}

export type Competitor = {
  name: string;
  change: string; // what happened between the two snapshots
  before: string; // the page text last week
  after: string; // the page text today
  hidden?: string; // text that sits in a tab the page keeps closed
  // One snapshot a week. The last two are the before and after pages.
  history: { week: string; text: string }[];
};

const SNAPSHOT_WEEKS = ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"];

type Rival = Omit<Competitor, "history">;

function withHistory(rival: Rival): Competitor {
  const texts = [rival.before, rival.before, rival.before, rival.after];
  const history = SNAPSHOT_WEEKS.map((week, index) => ({ week, text: texts[index] }));
  return { ...rival, history };
}

const RIVALS: Rival[] = [
  {
    name: "Pulsedesk",
    change: "price-rise",
    before: "Team plan: 49 dollars a month.",
    after: "Team plan: 79 dollars a month. New Free tier for up to 3 people.",
  },
  {
    name: "Tallyfox",
    change: "renamed-plan",
    before: "Plans: Starter, Pro. A cookie banner covers the page.",
    after: "Plans: Starter, Scale. A cookie banner covers the page.",
  },
  {
    name: "Orbitnote",
    change: "feature-removed",
    before: "Pricing tabs: Monthly, Yearly. Pro includes guest access.",
    after: "Pricing tabs: Monthly, Yearly. Pro no longer includes guest access.",
    hidden: "Yearly tab: Pro is 90 dollars a year.",
  },
  {
    name: "Lumenboard",
    change: "unchanged",
    before: "Business plan: 99 dollars a month.",
    after: "Business plan: 99 dollars a month.",
  },
];

export const COMPETITORS: Competitor[] = RIVALS.map(withHistory);
