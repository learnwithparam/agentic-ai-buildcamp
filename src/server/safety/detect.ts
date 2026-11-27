import type OpenAI from "openai";
import { z } from "zod";

// The second pass of the safety check. The router (src/server/tiers.ts) sorts every message into
// a tier with many other things to decide. This pass has one question and nothing else, asked of
// every message the router sent to "answer", so a message the router read as a question about the
// label, with an event mentioned on the way, still reaches a person. Either layer saying yes
// routes the message to safety (see withSecondPass in tiers.ts).
//
// It is its own function with its own output so it can be measured alone: scripts/ae-eval.ts
// scores it apart from the router.

export const SPECIAL_SITUATIONS = ["pregnancy_exposure", "overdose", "medication_error", "lack_of_efficacy", "off_label_use"] as const;
export type SpecialSituation = (typeof SPECIAL_SITUATIONS)[number];

// checkpoint-sync:begin safety-detect-prompt
export const DETECT_PROMPT = `You read one message sent to a pharmaceutical company's medical information desk.
Answer one question: does the message describe something that happened to a patient after a medicine?

Answer yes when the message tells of any of these, even when it is indirect, mixed in with a question, or about a patient who is not named:
- a symptom, sign, test result, hospital stay or death that followed a medicine, with or without the doctor blaming the medicine
- a patient exposed to the medicine while pregnant or breastfeeding
- a dose taken that was larger than prescribed (overdose), or a wrong drug, dose, patient or time given or nearly given (medication error)
- a medicine that did not work for the patient (lack of effect)
- the medicine used for something the label does not cover, when it describes what happened

Set harm to true when a symptom, sign, test result, hospital stay, death or lack of effect followed. Set it to false when the message tells only of an exposure, an overdose or an error and says the patient is well or names nothing wrong.

Answer no when the message only asks about the medicine in general, about what the label says, about a patient who has not started it, or about how to report. A side effect named only as a topic of a question ("is cough listed?") is no. So is a question about how often something happened across patients or in a trial ("what share stopped because of dizziness?"). A past event that is only a reason for a question about starting the medicine ("angioedema on an ACE inhibitor in 2019, does that rule out it?") is no unless it followed this company's medicine.

Reply with the JSON only.`;
// checkpoint-sync:end safety-detect-prompt

const Detected = z.object({
  happened: z.boolean(),
  harm: z.boolean(),
  special_situation: z.enum(SPECIAL_SITUATIONS).nullable(),
  reason: z.string()
});

export type Detection = { happened: boolean; harm: boolean; specialSituation: SpecialSituation | null; reason: string };

export async function detectEvent(openai: OpenAI, model: string, message: string): Promise<Detection> {
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: DETECT_PROMPT },
      { role: "user", content: `Message:\n${message}` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "detection",
        strict: true,
        schema: {
          type: "object",
          properties: {
            happened: { type: "boolean", description: "True when something happened to a patient after a medicine." },
            harm: { type: "boolean", description: "True when a symptom, sign, test result, hospital stay, death or lack of effect followed." },
            special_situation: { type: ["string", "null"], enum: [...SPECIAL_SITUATIONS, null] },
            reason: { type: "string", description: "One short sentence." }
          },
          required: ["happened", "harm", "special_situation", "reason"],
          additionalProperties: false
        }
      }
    }
  });
  const parsed = Detected.parse(JSON.parse(completion.choices[0]?.message.content ?? "{}"));
  return { happened: parsed.happened, harm: parsed.harm, specialSituation: parsed.special_situation, reason: parsed.reason };
}
