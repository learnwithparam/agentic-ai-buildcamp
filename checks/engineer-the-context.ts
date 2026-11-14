// context.yaml: what the model reads for one job, what it costs, and what was left out on purpose.
import type { Rule } from "../scripts/verify";
import { hasFile, readYaml } from "./design-lib";

type ContextItem = {
  name?: unknown;
  source?: unknown;
  tokens?: unknown;
  why?: unknown;
  keep?: unknown;
};
type LeftOut = { name?: unknown; why?: unknown };
type ContextFile = { budget_tokens?: unknown; items?: ContextItem[]; left_out?: LeftOut[] };

function contextIn(folder: string): ContextFile {
  if (!hasFile(folder, "context.yaml")) return {};
  return readYaml<ContextFile>(folder, "context.yaml") ?? {};
}

function itemsIn(folder: string): ContextItem[] {
  const items = contextIn(folder).items;
  if (Array.isArray(items)) return items;
  return [];
}

const isText = (value: unknown, minimumWords: number) =>
  typeof value === "string" && value.trim().split(/\s+/).length >= minimumWords;

function budgetIn(folder: string): number {
  const budget = contextIn(folder).budget_tokens;
  if (typeof budget === "number" && budget > 0) return budget;
  return 0;
}

const costOf = (item: ContextItem) => (typeof item.tokens === "number" ? item.tokens : 0);

function totalTokens(folder: string): number {
  return itemsIn(folder).reduce((total, item) => total + costOf(item), 0);
}

function isMustNever(item: ContextItem): boolean {
  const name = String(item.name ?? "").toLowerCase();
  return /must.never/.test(name) && item.keep === "always";
}

function leftOutOnPurpose(folder: string): boolean {
  const leftOut = contextIn(folder).left_out;
  if (!Array.isArray(leftOut)) return false;
  return (
    leftOut.length >= 2 && leftOut.every((entry) => isText(entry.name, 1) && isText(entry.why, 4))
  );
}

export default [
  {
    says: "context.yaml has a token budget and at least three items",
    test: (folder) => budgetIn(folder) > 0 && itemsIn(folder).length >= 3,
    tryNext: "set budget_tokens above zero and list the items the model reads for one job",
  },
  {
    says: "every item has a source, a cost in tokens and a reason",
    test: (folder) =>
      itemsIn(folder).length > 0 &&
      itemsIn(folder).every(
        (item) => isText(item.source, 1) && costOf(item) > 0 && isText(item.why, 4),
      ),
    tryNext: "give each item a source, a tokens number above zero, and a why of a few words",
  },
  {
    says: "the items fit inside the budget",
    test: (folder) => budgetIn(folder) > 0 && totalTokens(folder) <= budgetIn(folder),
    tryNext: "cut the biggest item down, or drop one that this job does not need",
  },
  {
    says: "no single item takes more than 40 percent of the budget",
    test: (folder) =>
      budgetIn(folder) > 0 &&
      itemsIn(folder).every((item) => costOf(item) <= budgetIn(folder) * 0.4),
    tryNext: "summarise or trim the big item, since one file should not crowd out the rest",
  },
  {
    says: "the must-never rule is its own item that is always kept",
    test: (folder) => itemsIn(folder).some(isMustNever),
    tryNext: 'add an item named "must-never rule" with keep: always',
  },
  {
    says: "at least two things are left out on purpose, each with a reason",
    test: leftOutOnPurpose,
    tryNext: "add left_out entries with a name and a why, such as old chat history",
  },
] satisfies Rule[];
