// The router reads a question first and picks a path. Cheap and safe paths never call a model.
import { BRANDS } from "../../../data/catalog/brands";
import type { Intent } from "../../../src/golden";
import type { AgentResult } from "../../../src/grade";
import { type Tags, traced } from "./telemetry";

export type Decision = { route: Intent; reason: string };

const SAFETY_WORDS = ["rash", "reaction", "hospital", "side effect", "vomit", "dizzy", "fainted"];
const OFF_LABEL_WORDS = ["works for", "cure", "off-label"];
const TOPIC_WORDS = [
  "dose",
  "label",
  "sales",
  "territor",
  "prescri",
  "patient",
  "study",
  "report",
].concat(["safety", "approved", "leaflet", "puffs", "tablet", "drive"]);

function has(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function namesBrand(text: string): boolean {
  return BRANDS.some((brand) => text.includes(brand.name.toLowerCase()));
}

// #region step:intent-routing
export function decide(question: string): Decision {
  const text = question.toLowerCase();
  if (text.startsWith("send the approved")) return { route: "approve", reason: "needs approval" };
  if (has(text, SAFETY_WORDS)) return { route: "escalate", reason: "possible adverse event" };
  if (has(text, OFF_LABEL_WORDS)) return { route: "refuse", reason: "off-label" };
  if (!namesBrand(text) && !has(text, TOPIC_WORDS)) return { route: "template", reason: "trivia" };
  return { route: "answer", reason: "medical affairs question" };
}
// #stub
//~ // TODO(intent-routing): send safety, approval, off-label and trivia questions down their paths
//~ export function decide(_question: string): Decision {
//~   return { route: "answer", reason: "medical affairs question" };
//~ }
// #endregion

const REPLIES: Record<string, string> = {
  template: "That is outside medical affairs. Ask me about a label, a safety note or sales.",
  refuse: "I cannot discuss a use that is not on the label.",
  escalate: "A safety reviewer must see this report first. I have not sent any reply.",
  approve: "A reviewer must approve this reply before anything is sent.",
};

// Runs the chosen path. Only the answer path may call a model, so it comes from the caller.
export async function handle(
  question: string,
  tags: Tags,
  answer: (question: string) => Promise<AgentResult>,
): Promise<AgentResult> {
  return traced("route", tags, async (setAttributes) => {
    const decision = decide(question);
    setAttributes({ route: decision.route, reason: decision.reason });
    if (decision.route === "answer") return answer(question);
    return { route: decision.route, text: REPLIES[decision.route], citations: [] };
  });
}
