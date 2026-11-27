import type OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "../shared/messages";
import { aiText } from "../shared/messages";
import { shortStage } from "./gateway";
import type { LabelSection } from "./labels";
import { detectEvent, type Detection, type SpecialSituation } from "./safety/detect";

// Lesson 13. Before the agent writes a word, every message is sorted into a risk tier, and the
// tier decides who must look before the doctor reads anything:
//
//   answer  a cited fact from the label, straight to the doctor
//   review  a draft for someone else (an email, a letter): a medical reviewer approves it first
//   safety  something happened to a patient: the drug safety team gets it within 24 hours, and
//           no treatment advice is given until a human has read it
//   stop    a use the label does not cover: a fixed refusal, no dose
//
// The sorting is one model call with a fixed set of answers. What each tier then does is code,
// so a prompt cannot skip the reviewer.

export const TIERS = ["answer", "review", "safety", "stop"] as const;
export type Tier = (typeof TIERS)[number];

// How long each human has. The inbox shows the deadline; the safety reply quotes it.
export const SAFETY_HOURS = 24;
export const REVIEW_HOURS = 48;

// report: a special situation with no harm (a pregnancy exposure, an overdose with the patient
// well). The doctor gets the label's answer and a safety case is opened beside it (issue #122).
export type Route = { tier: Tier; reason: string; basis?: string; asksForAdvice: boolean; report?: SpecialSituation };

// The approved uses the router compares a question with: the indication text of each label the
// signed-in user may read and that is in force.
export function approvedUses(readable: ReadonlySet<string>, sections: LabelSection[]): LabelSection[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    if (!readable.has(section.docId) || section.status !== "active" || seen.has(section.docId)) return false;
    if (!/\bis indicated\b/i.test(section.text)) return false;
    seen.add(section.docId);
    return true;
  });
}

const cite = (section: LabelSection) => `${section.docId}, ${section.section}`;

// checkpoint-sync:begin router-prompt
export const ROUTER_PROMPT = `You sort one message sent to a pharmaceutical company's medical information desk.
Call route with exactly one tier.
Sort only the message under "Message to sort". Earlier turns only tell you which medicine and patient it is about: a refused earlier message does not make this one refused, and an earlier answer does not make this one safe.

- safety: the message tells of something that happened to a patient after taking a medicine (a side effect, a reaction, a hospital stay, a faint, swelling, a rash), even when it also asks a question.
- stop: the message asks how to use one of the medicines below for a use or a patient its approved use does not cover (another disease, a child when the use is for adults).
  A medicine that is not in the list below is never stop: this desk has no label for it, so that is answer, and the search says it has nothing.
  A patient who has the approved disease is covered, even when they are pregnant, breastfeeding, older, or have kidney or liver disease. The label has its own sections for these patients, so that is answer, not stop.
- review: the message asks for a draft or a written message to send to someone (a reply, an email, a letter).
- answer: anything else, including questions about how safety reports work, storage, and doses within the approved use.

If more than one fits, the first in this list wins: safety, stop, review, answer.
Set asks_for_advice to true when the message asks what to do for a patient (give, change, stop or continue a dose).
Set basis to the approved use you compared with, for stop; leave it out otherwise.`;
// checkpoint-sync:end router-prompt

// A fixed floor under the router: a message that asks for something written to send always goes
// to a reviewer, whatever the router said. It can only raise answer to review, never lower a tier.
// There is no such floor for safety: a word list misreads questions about the procedure itself
// ("how do I report a side effect?"), so every safety call stays with the router and the dataset.
export const DRAFT_REQUEST = /\b(draft|write)\b[\s\S]*\b(reply|email|letter|response|message)\b/i;

export function withFloor(route: Route, question: string): Route {
  if (route.tier !== "answer" || !DRAFT_REQUEST.test(question)) return route;
  return { ...route, tier: "review", reason: `${route.reason} (raised to review: the message asks for a draft)` };
}

// The second layer. A message the router sent to "answer" is read once more with one question
// only: did something happen to a patient after a medicine? A yes from either layer reaches the
// safety inbox. Its own function (detectEvent) so it can be measured alone.
// A special situation with no harm is still reported, and the doctor also gets the answer, as EU
// GVP Module VI asks: "she is 9 weeks pregnant on CardioNex, should she stay on it?" needs the
// label's 8.1 as much as it needs a report. Every other yes gets the fixed safety reply alone.
export function raiseToSafety(route: Route, seen: Detection): Route {
  const reportOnly = seen.happened && !seen.harm && seen.specialSituation !== null;
  // Only an answer is kept an answer. A router that said safety is never lowered: two layers
  // must both read no harm, and the safety node files the report anyway.
  if (reportOnly && route.tier === "answer") {
    return { ...route, tier: "answer", report: seen.specialSituation!, reason: `${route.reason} (answered, and a ${seen.specialSituation} report opened by the second pass: ${seen.reason})` };
  }
  if (route.tier !== "answer" || !seen.happened) return route;
  return { ...route, tier: "safety", reason: `${route.reason} (raised to safety by the second pass: ${seen.reason})` };
}

// Both calls read only the message, so they run at the same time and a turn waits for the slower
// one, not for both in a row. Only an answer is raised: every other tier already has a person or a
// fixed reply, so for those the second pass's verdict is not used.
export async function withSecondPass(routing: Promise<Route>, openai: OpenAI, model: string, message: string): Promise<Route> {
  const [route, seen] = await Promise.all([routing, detectEvent(openai, model, message)]);
  return raiseToSafety(route, seen);
}

const RouteArgs = z.object({
  tier: z.enum(TIERS),
  reason: z.string(),
  asks_for_advice: z.boolean(),
  basis: z.string().optional()
});

export function routeTool(uses: LabelSection[]): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: "route",
      description: "Record the risk tier of the message.",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: [...TIERS] },
          reason: { type: "string", description: "One short sentence: why this tier." },
          asks_for_advice: { type: "boolean" },
          ...(uses.length ? { basis: { type: "string", enum: uses.map(cite) } } : {})
        },
        required: ["tier", "reason", "asks_for_advice"],
        additionalProperties: false
      }
    }
  };
}

// What the router reads. Only the latest message is sorted. Earlier turns come as context, so a
// follow-up such as "US patient with eGFR 32?" still knows which medicine it is about. A desk reply
// comes as its kind only ("refused: OFF_LABEL_REFUSAL"), never its text: a refusal's wording
// would make every later message look like the refused one.
const REPLY_CODE = /^([A-Z][A-Z_]{3,})\b/;

function deskKind(text: string): string {
  const code = REPLY_CODE.exec(text.trim())?.[1];
  return code ? `the desk replied ${code}` : "the desk answered";
}

export function routerInput(messages: ChatMessage[]): string {
  const said = messages.flatMap((message) => {
    if (message.type === "human") return [{ doctor: true, text: message.content }];
    if (message.type === "ai" && aiText(message)) return [{ doctor: false, text: aiText(message) }];
    return [];
  });
  const lastAt = said.map((line) => line.doctor).lastIndexOf(true);
  if (lastAt < 0) return "";
  const earlier = said
    .slice(0, lastAt)
    .slice(-6)
    .map((line) => (line.doctor ? `Doctor: ${line.text}` : `(${deskKind(line.text)})`));
  const latest = `Message to sort:\nDoctor: ${said[lastAt]!.text}`;
  return earlier.length ? `Earlier turns, for context only:\n${earlier.join("\n")}\n\n${latest}` : latest;
}

// Fix 2, measured by its contract: the router stays on the chat model. The Decisions API that
// decide() calls returns one choice and no text, and the router must also give its reason and
// the approved use it rests on, which the trace and the review inbox show. decide() stays the
// behavior judge in scripts/experiment.ts, where one typed choice is the whole answer.
export async function routeRequest(openai: OpenAI, messages: ChatMessage[], uses: LabelSection[]): Promise<Route> {
  const useList = uses.length
    ? uses.map((section) => `[${cite(section)}] ${section.text}`).join("\n")
    : "(none: this desk has no label in force for this user)";
  const completion = await openai.chat.completions.create({
    temperature: 0,
    ...shortStage("router"),
    messages: [
      { role: "system", content: `${ROUTER_PROMPT}\n\nApproved uses:\n${useList}` },
      { role: "user", content: routerInput(messages) }
    ],
    tools: [routeTool(uses)],
    tool_choice: { type: "function", function: { name: "route" } }
  });
  const call = completion.choices[0]?.message.tool_calls?.find((item) => item.type === "function" && item.function.name === "route");
  if (!call || call.type !== "function") throw new Error("The router did not choose a tier.");
  const args = RouteArgs.parse(JSON.parse(call.function.arguments));
  return { tier: args.tier, reason: args.reason, basis: args.basis, asksForAdvice: args.asks_for_advice };
}

// --- What the safety and stop tiers say. Fixed text, so it reads the same every time and a
// reviewer can approve the wording once.

// The company's own reporting procedure, when this user may read it.
export function reportingProcedure(readable: ReadonlySet<string>, sections: LabelSection[]) {
  const sop = sections.filter((section) => readable.has(section.docId) && section.status === "active" && section.docId.startsWith("pv-reporting-sop"));
  return { when: sop.find((section) => section.section === "1.1"), holds: sop.find((section) => section.section === "1.2") };
}

export function safetyReply(input: {
  asksForAdvice: boolean;
  removedIdentifiers: number;
  procedure: ReturnType<typeof reportingProcedure>;
}): string {
  const { when, holds } = input.procedure;
  const lines = [
    "PV_ESCALATION",
    `This is an adverse event report. It goes to the drug safety team within ${SAFETY_HOURS} hours of first contact, and a human safety reviewer files it. The assistant never files it${when ? ` [${cite(when)}]` : ""}.`
  ];
  if (input.removedIdentifiers) {
    lines.push(`I removed the patient's identifiers from this conversation. A safety report never holds them${holds ? ` [${cite(holds)}]` : ""}.`);
  }
  if (input.asksForAdvice) {
    lines.push("I cannot advise on this patient's treatment here. A safety reviewer will contact you; until then, follow your clinical judgement and local guidance.");
  }
  return lines.join("\n\n");
}

export function stopReply(basis: string | undefined): string {
  return [
    "OFF_LABEL_REFUSAL",
    `The approved label does not cover this use, so I cannot give a dose for it${basis ? ` [${basis}]` : ""}.`,
    "For a question outside the label, ask your company's medical science liaison."
  ].join("\n\n");
}
