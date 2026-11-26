import type OpenAI from "openai";
import { buildE2bDraft } from "./e2b";
import { extractCase } from "./extract";

// What a safety reviewer finds under the fixed reply in the inbox item: the criteria this report
// meets and lacks, the coded events, and the E2B(R3)-shaped draft. The reviewer checks it and
// files the case; nothing here is sent anywhere.
export async function reviewerDraft(openai: OpenAI, model: string, message: string, caseId: string, now: Date = new Date()): Promise<string> {
  const safety = await extractCase(openai, model, message);
  const draft = buildE2bDraft(safety, { caseId, receivedAt: now, createdAt: now, narrative: message });
  const coded = safety.events.map((event) => `${event.reportedTerm} -> ${event.coded ? `${event.coded.pt.name} (PT ${event.coded.pt.code})` : "no code in the dictionary"}`);
  return [
    "CASE DRAFT FOR THE SAFETY REVIEWER (not submitted)",
    `ICH E2D(R1) minimum criteria: ${(["reporter", "patient", "product", "event"] as const).map((name) => `${name} ${safety.criteria[name] ? "yes" : "NO"}`).join(", ")}.`,
    safety.missing.length ? `Not yet a valid case. Ask the reporter for: ${safety.missing.join(", ")}.` : "All four criteria are met.",
    safety.specialSituation ? `Special situation: ${safety.specialSituation}.` : "",
    coded.length ? `Events:\n${coded.map((line) => `- ${line}`).join("\n")}` : "Events: none stated.",
    draft.xml
  ]
    .filter(Boolean)
    .join("\n\n");
}
