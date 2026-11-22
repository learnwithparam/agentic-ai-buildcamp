// The naive agent. It pastes every document and every prescriber into one prompt and asks.
// It is wrong on purpose. Each later module fixes one thing this agent gets wrong.
import { DOCUMENTS } from "../../../data/catalog/documents";
import { PRESCRIBERS } from "../../../data/catalog/prescribers";
import { ask } from "../../../packages/core/src/ask";
import type { AgentResult } from "../../../src/grade";

// #region step:foundation
export function naivePrompt(question: string): string {
  const documents = DOCUMENTS.map((item) => `${item.title}\n${item.body}`).join("\n\n");
  const doctors = PRESCRIBERS.map((item) => [item.name, item.npi, item.email].join(" ")).join("\n");
  const parts = [
    "You help a medical affairs team.",
    documents,
    `Prescribers:\n${doctors}`,
    question,
  ];
  return parts.join("\n\n");
}
// #stub
//~ // TODO(foundation): paste every document and every prescriber into one prompt
//~ export function naivePrompt(question: string): string {
//~   return question;
//~ }
// #endregion

export async function askNaively(question: string): Promise<AgentResult> {
  const reply = await ask("fast", naivePrompt(question));
  return { route: "answer", text: reply.text, citations: [] };
}
