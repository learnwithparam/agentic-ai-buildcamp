import type OpenAI from "openai";
import { z } from "zod";
import { SPECIAL_SITUATIONS, type SpecialSituation } from "./detect";
import { dictionary, type Coded } from "./meddra";

// The four minimum criteria for a valid case (ICH E2D(R1) section 2.2): an identifiable reporter,
// an identifiable patient, a suspect product and an adverse event. A case missing any one is
// still kept and followed up; it is not yet a valid case.
//
// The model reads the message and fills in what it says, field by field, and proposes terms for
// the events. Code then decides each criterion from those fields and turns terms into codes with
// the dictionary (meddra.ts). The model never says "criterion met" and never writes a code.

export const SERIOUSNESS = ["death", "life_threatening", "hospitalization", "disability", "congenital_anomaly", "other_medically_important"] as const;
export type Seriousness = (typeof SERIOUSNESS)[number];

// checkpoint-sync:begin safety-extract-prompt
export const EXTRACT_PROMPT = `You read one message sent to a pharmaceutical company's medical information desk and fill in a safety case form from what it says. Write only what the message says; use null or an empty list for anything it does not say. Never guess a name, an age or a product.

- reporter_role: who is writing (doctor, pharmacist, nurse, caller who is a doctor), or null if the message does not say. A person who writes about their patient as "my patient" is a doctor.
- patient: what identifies the patient: age (as written), sex (male, female), initials or a label such as "Mr Hall" or "Mrs Koh". Leave a field null when absent. A patient described only as "a patient" or "a patient of mine" with none of these has no identifiers.
- product: the medicine's name as the message gives it, or null when the message does not name it ("my tablets", "the drug").
- events: only what happened to the patient. A symptom, sign, test result, hospital stay or death. For each, reported_term is the words from the message and term is the closest term from the allowed list, or null if none fits. A lack of effect is an event: use the term for it. An overdose, a medication error that was caught, or a pregnancy exposure with nothing yet wrong has no event: leave events empty and set special_situation.
- special_situation: pregnancy_exposure, overdose, medication_error, lack_of_efficacy or off_label_use, or null.
- seriousness: every criterion that applies to the events: death, life_threatening, hospitalization, disability, congenital_anomaly, other_medically_important. Empty when none.`;
// checkpoint-sync:end safety-extract-prompt

const Extracted = z.object({
  reporter_role: z.string().nullable(),
  patient: z.object({ age: z.string().nullable(), sex: z.string().nullable(), initials_or_label: z.string().nullable() }),
  product: z.string().nullable(),
  events: z.array(z.object({ reported_term: z.string(), term: z.string().nullable() })),
  special_situation: z.enum(SPECIAL_SITUATIONS).nullable(),
  seriousness: z.array(z.enum(SERIOUSNESS))
});
export type Extracted = z.infer<typeof Extracted>;

export type Criteria = { reporter: boolean; patient: boolean; product: boolean; event: boolean };

export type CodedEvent = { reportedTerm: string; coded: Coded | null };

export type SafetyCase = {
  extracted: Extracted;
  criteria: Criteria;
  events: CodedEvent[];
  specialSituation: SpecialSituation | null;
  seriousness: Seriousness[];
  // The criteria still missing, for the follow-up question a safety reviewer sends.
  missing: Array<keyof Criteria>;
};

const present = (value: string | null | undefined) => Boolean(value && value.trim());

// Each criterion is decided here, from the fields. A reporter is identifiable when the message
// says who they are, a patient when it gives any one identifier (ICH E2D(R1): age, sex, initials
// or a code), a product when it is named, an event when at least one thing happened.
export function criteriaOf(extracted: Extracted): Criteria {
  const { patient } = extracted;
  return {
    reporter: present(extracted.reporter_role),
    patient: present(patient.age) || present(patient.sex) || present(patient.initials_or_label),
    product: present(extracted.product),
    event: extracted.events.length > 0
  };
}

// The model's proposed term becomes a code only through the dictionary. A term it does not hold
// gets no code (coded: null), and the reviewer codes it by hand.
export function buildCase(extracted: Extracted): SafetyCase {
  const criteria = criteriaOf(extracted);
  const events = extracted.events.map((event) => ({
    reportedTerm: event.reported_term,
    coded: event.term ? dictionary().code(event.term) : null
  }));
  return {
    extracted,
    criteria,
    events,
    specialSituation: extracted.special_situation,
    seriousness: extracted.seriousness,
    missing: (Object.keys(criteria) as Array<keyof Criteria>).filter((name) => !criteria[name])
  };
}

export async function extractCase(openai: OpenAI, model: string, message: string): Promise<SafetyCase> {
  const nullable = { type: ["string", "null"] } as const;
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `Message:\n${message}` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "safety_case",
        strict: true,
        schema: {
          type: "object",
          properties: {
            reporter_role: nullable,
            patient: {
              type: "object",
              properties: { age: nullable, sex: nullable, initials_or_label: nullable },
              required: ["age", "sex", "initials_or_label"],
              additionalProperties: false
            },
            product: nullable,
            events: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  reported_term: { type: "string" },
                  term: { type: ["string", "null"], enum: [...dictionary().termNames(), null] }
                },
                required: ["reported_term", "term"],
                additionalProperties: false
              }
            },
            special_situation: { type: ["string", "null"], enum: [...SPECIAL_SITUATIONS, null] },
            seriousness: { type: "array", items: { type: "string", enum: [...SERIOUSNESS] } }
          },
          required: ["reporter_role", "patient", "product", "events", "special_situation", "seriousness"],
          additionalProperties: false
        }
      }
    }
  });
  return buildCase(Extracted.parse(JSON.parse(completion.choices[0]?.message.content ?? "{}")));
}
