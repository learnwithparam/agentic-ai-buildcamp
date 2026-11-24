import type OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "../shared/messages";
import { aiText } from "../shared/messages";
import type { LabelSection } from "./labels";

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

export type Route = { tier: Tier; reason: string; basis?: string; asksForAdvice: boolean };

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

- safety: the message tells of something that happened to a patient after taking a medicine (a side effect, a reaction, a hospital stay, a faint, swelling, a rash), even when it also asks a question.
- stop: the message asks how to use one of the medicines below for a use or a patient its approved use does not cover (another disease, a child when the use is for adults).
- review: the message asks for a draft or a written message to send to someone (a reply, an email, a letter).
- answer: anything else, including questions about how safety reports work, storage, and doses within the approved use.

If more than one fits, the first in this list wins: safety, stop, review, answer.
Set asks_for_advice to true when the message asks what to do for a patient (give, change, stop or continue a dose).
Set basis to the approved use you compared with, for stop; leave it out otherwise.`;
// checkpoint-sync:end router-prompt

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

// The conversation as the router reads it: who said what, as plain text, the latest message last.
function transcript(messages: ChatMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.type === "human") return [`Doctor: ${message.content}`];
      if (message.type === "ai" && aiText(message)) return [`Desk: ${aiText(message)}`];
      return [];
    })
    .slice(-6)
    .join("\n\n");
}

export async function routeRequest(openai: OpenAI, model: string, messages: ChatMessage[], uses: LabelSection[]): Promise<Route> {
  const useList = uses.length
    ? uses.map((section) => `[${cite(section)}] ${section.text}`).join("\n")
    : "(none: this desk has no label in force for this user)";
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: `${ROUTER_PROMPT}\n\nApproved uses:\n${useList}` },
      { role: "user", content: transcript(messages) }
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
