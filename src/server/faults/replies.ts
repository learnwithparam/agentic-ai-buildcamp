import type { ErrorRequestHandler } from "express";
import { BUDGET_SPENT_MESSAGE, isBudgetSpent } from "../gateway";

// What a doctor reads when the agent breaks mid-answer. The chat route and the fault measure
// (scripts/faults-eval.ts) both take it from here, so the measure scores the words the route sends.
export const AGENT_ERROR_REPLY = "The agent could not finish this answer. Please try again.";

export function replyForError(error: unknown): string {
  return isBudgetSpent(error) ? BUDGET_SPENT_MESSAGE : AGENT_ERROR_REPLY;
}

// What a route answers when it throws before it can answer for itself, for example when OpenFGA
// does not respond. Express's own handler would send the stack trace as a page.
export const API_ERROR_REPLY = "The service could not finish this request. Please try again.";

export const apiErrors: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) return next(error);
  console.error(error);
  const spent = isBudgetSpent(error);
  response.status(spent ? 429 : 503).json({ error: spent ? BUDGET_SPENT_MESSAGE : API_ERROR_REPLY });
};
