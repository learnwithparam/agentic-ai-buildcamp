// Guardrails check text before the agent reads it. A line that gives orders is never followed.
// The same list guards a question and the text of a document.

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
export function givesOrders(text: string): boolean {
  const lower = text.toLowerCase();
  return ORDERS.some((phrase) => lower.includes(phrase));
}

// Drops every line that gives orders and keeps the rest of the document.
export function scrubDocument(body: string): string {
  const kept = body.split("\n").filter((line) => !givesOrders(line));
  return kept.join("\n");
}
// #stub
//~ // TODO(guardrails-workers): find lines that give orders and drop them from documents
//~ export function givesOrders(_text: string): boolean {
//~   return false;
//~ }
//~
//~ export function scrubDocument(body: string): string {
//~   return body;
//~ }
// #endregion
