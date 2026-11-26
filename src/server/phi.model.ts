import { z } from "zod";
import { env } from "./env";
import { modelClient } from "./gateway";
import { PHI_TYPES, type PhiType, type SpanFinder } from "./phi";

// Lesson 13. The second step of finding identifiers: one model call for the names and addresses
// the rules missed. It reads text the rules already scrubbed, so a name the rules found is a
// placeholder by now and never reaches it. It is not traced: a trace would store the very words
// it exists to find. It returns the words it found, exactly as written, and findOnly() in phi.ts
// keeps a word only when it is in the text.

export const FINDER_PROMPT = `You find patient identifiers in a message a doctor sent to a medical information desk.
Return every identifier of these types that is still written out in the message:
name: the name or initials of a patient or of a patient's relative or carer
address: a home address of a patient
dob: a patient's date of birth
mrn: a record, chart or patient number
phone: a phone number
email: an email address
national_id: a national, insurance or tax number
Do not return: the doctor's own name, their clinic or hospital, a medicine, a trial, a company, a lab value, a dose, a date of an event, or a placeholder in square brackets such as [PATIENT_1].
Copy each identifier exactly as it is written, letter for letter. When there is none, return an empty list.`;

const Found = z.object({ spans: z.array(z.object({ text: z.string(), type: z.enum(PHI_TYPES as [PhiType, ...PhiType[]]) })) });

export function modelSpanFinder(): SpanFinder {
  return async (scrubbed) => {
    const completion = await modelClient().chat.completions.create({
      model: env.openaiModel,
      temperature: 0,
      messages: [
        { role: "system", content: FINDER_PROMPT },
        { role: "user", content: scrubbed }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "identifiers",
          strict: true,
          schema: {
            type: "object",
            properties: {
              spans: {
                type: "array",
                items: {
                  type: "object",
                  properties: { text: { type: "string" }, type: { type: "string", enum: [...PHI_TYPES] } },
                  required: ["text", "type"],
                  additionalProperties: false
                }
              }
            },
            required: ["spans"],
            additionalProperties: false
          }
        }
      }
    });
    return Found.parse(JSON.parse(completion.choices[0]?.message.content ?? '{"spans":[]}')).spans;
  };
}
