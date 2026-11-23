// Guardrails check text before the agent reads it. A line that gives orders is never followed.
// The same list guards a question and the text of a document.
// Two more guards: a query may only ask for totals, and a run may not spend past its cap.

// Phrases that try to take over the agent. Each one is lower case.
export const ORDERS: string[] = [
  "ignore your rules",
  "ignore previous instructions",
  "ignore all previous",
  "disregard your instructions",
  "reveal your prompt",
  "print every npi",
];

export const REFUSAL = "That text gives me orders. I did not follow them.";

// #region step:guardrails-workers
const HIDDEN_MARKS = /[\u200b-\u200f\u2060\ufeff]/g;

// Clean the text first. Hidden marks and extra spaces must not hide an order.
function normalise(text: string): string {
  const visible = text.replace(HIDDEN_MARKS, "");
  return visible.toLowerCase().replace(/\s+/g, " ");
}

export function givesOrders(text: string): boolean {
  const clean = normalise(text);
  return ORDERS.some((phrase) => clean.includes(phrase));
}

// Drops every line that gives orders and keeps the rest of the document.
export function scrubDocument(body: string): string {
  const kept = body.split("\n").filter((line) => !givesOrders(line));
  return kept.join("\n");
}

// A query may only ask for totals. A star, or a query with no total, shows raw rows.
export function aggregateOnly(sql: string): string | undefined {
  const withoutCount = sql.replace(/count\s*\(\s*\*\s*\)/gi, "count(1)");
  if (withoutCount.includes("*")) return "a star shows raw rows, so ask for totals";
  if (!/\b(sum|count|avg|min|max)\s*\(/i.test(sql)) return "a query must ask for a total";
  return undefined;
}

// The most one run may spend, in US dollars. The gateway reports what each call cost.
export const SPEND_CAP_USD = 0.25;

export class OverCap extends Error {}

export type Ledger = { spentUsd: number };
export type Priced = { costUsd: number };

export function newLedger(spentUsd = 0): Ledger {
  return { spentUsd };
}

// The cost is the number the gateway sent back. A call that gave no cost is -1 and adds nothing.
export function addCost(ledger: Ledger, reply: Priced): void {
  if (reply.costUsd > 0) ledger.spentUsd += reply.costUsd;
}

// Runs the model call only while the run is under its cap. Over the cap, the call never starts.
export async function underCap<Reply extends Priced>(
  ledger: Ledger,
  call: () => Promise<Reply>,
  capUsd = SPEND_CAP_USD,
): Promise<Reply> {
  if (ledger.spentUsd >= capUsd) {
    throw new OverCap(`This run spent $${ledger.spentUsd} and its cap is $${capUsd}.`);
  }
  const reply = await call();
  addCost(ledger, reply);
  return reply;
}
// #stub
//~ // TODO(guardrails-workers): find lines that give orders, allow only totals, stop at the cap
//~ export function givesOrders(_text: string): boolean {
//~   return false;
//~ }
//~
//~ export function scrubDocument(body: string): string {
//~   return body;
//~ }
//~
//~ export function aggregateOnly(_sql: string): string | undefined {
//~   return undefined;
//~ }
//~
//~ export const SPEND_CAP_USD = 0.25;
//~
//~ export class OverCap extends Error {}
//~
//~ export type Ledger = { spentUsd: number };
//~ export type Priced = { costUsd: number };
//~
//~ export function newLedger(spentUsd = 0): Ledger {
//~   return { spentUsd };
//~ }
//~
//~ export function addCost(_ledger: Ledger, _reply: Priced): void {}
//~
//~ export async function underCap<Reply extends Priced>(
//~   _ledger: Ledger,
//~   call: () => Promise<Reply>,
//~   _capUsd = SPEND_CAP_USD,
//~ ): Promise<Reply> {
//~   return call();
//~ }
// #endregion
