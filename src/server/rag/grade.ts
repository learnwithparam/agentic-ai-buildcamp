import { observeOpenAI } from "@langfuse/openai";
import { z } from "zod";
import { modelClient, shortStage } from "../gateway";
import { timed } from "../ops/meter";

// Lesson 20, step 4 of search_labels. Two searches find what is near the question; they cannot
// tell a section that answers it from one that only shares its words. "Can a patient have a
// live vaccine?" sits near the sections about other medicines, and no label here mentions
// vaccines: the search must say it has nothing, not return the nearest interaction section.
//
// So the chat model reads the question and every candidate, and grades each one, as PaperQA2
// does with its evidence. One call grades all of them, so a search costs one call, not thirty.
// The gateway has no reranking endpoint, and every model call goes through the gateway.

// source names the document, its medicine and its country. Without it a passage reads "2.5
// Discontinuation", and a question about stopping NeuroVex was graded as answered by CardioNex's.
// It also says from when the document is in force: on 2027-04-15 the March 2027 label halved the
// renal dose, and the FAQ and the 2026 formulary, which still give the old one, were ranked first.
// grades has one grade per passage. best lists the passages that answer (grade 2 or 3), most
// direct first, by their index in passages. Graded one at a time, nearly every relevant section
// got a 3, so the grade could not order them: measured, 25 of the 30 answers missing from the top
// 5 had been graded, and lost only on order. Ranking them side by side (as RankGPT does) orders
// them, in the same call.
export type Grading = { grades: number[]; best: number[] };
export type Grader = (question: string, passages: Array<{ source: string; path: string; text: string }>) => Promise<Grading>;

export const GRADES = `3 states, in its own text, what the question asks for: the number, the yes or no, or the instruction.
2 states part of it, or the rule the answer depends on (a table, a limit, a "do not use").
1 is about the same subject, or gives background, but a doctor could not answer from it.
0 is about something else.`;

// checkpoint-sync:begin grader-prompt
export const GRADER_PROMPT = `You grade passages from medicine labels against one question from a doctor.
Grade every passage on its own, from its text only. A passage that only shares words with the question, or is about a nearby subject, is 1 or 0.
A passage about another medicine than the one the question asks about is 0.
When the question names a condition, substance, population or situation the answer depends on (a kidney problem, pregnancy, a child, another medicine), a passage that does not speak to it, in any words, is at most 1, even when it states the general rule. A word the answer does not depend on, such as "an adult" in a question about storage, changes no grade.
When the question names a trial, a payer, a formulary or the FAQ, the passages from that document that answer it are graded like any other. Only when two passages give different values for the same instruction (a dose, a limit, an interval) does the prescribing label (a document id with uspi, smpc or label in it) win: the other passage is at most 1, and among labels, the one in force from the latest date wins.
${GRADES}
Return one grade per passage, in the order given. Then, in best, list the numbers of the passages you graded 2 or 3, the one a doctor should read first at the start: the one that states the answer most directly.`;
// checkpoint-sync:end grader-prompt

const Graded = z.object({ grades: z.array(z.number().int().min(0).max(3)), best: z.array(z.number().int()) });

// A reply the desk cannot use: empty, not JSON, or the wrong shape (GradeReplyError), or a list of
// the wrong length (GradeCountError).
export class GradeReplyError extends Error {}
export class GradeCountError extends GradeReplyError {}

// A list of the wrong length is a broken answer, and guessing which grade belongs to which
// passage would cite the wrong section. Measured on 2026-11-26: 32 grades for 30 passages, once,
// 20 questions into a run. The schema pins the length and the request states it; if the model
// still miscounts, it is asked once more, and a second miscount fails the search. An empty reply is
// treated the same way. Measured on 2026-11-27: the grader returned no content once in an ops run.
export const retryOnMiscount = (once: Grader): Grader => async (question, passages) => {
  if (!passages.length) return { grades: [], best: [] };
  try {
    return await timed("search_grading", () => once(question, passages));
  } catch (error) {
    if (!(error instanceof GradeReplyError)) throw error;
    return timed("search_grading_retry", () => once(question, passages));
  }
};

// The model's reply as grades, or a GradeReplyError the caller may retry.
export function readGrades(choice: { message: { content: string | null }; finish_reason?: string | null } | undefined, count: number) {
  let reply: z.infer<typeof Graded>;
  try {
    reply = Graded.parse(JSON.parse(choice?.message.content ?? ""));
  } catch {
    throw new GradeReplyError(`The grader's reply was not a grade list (finish_reason ${choice?.finish_reason ?? "none"}).`);
  }
  const { grades, best } = reply;
  if (grades.length !== count) throw new GradeCountError(`The grader returned ${grades.length} grades for ${count} passages.`);
  // best counts from 1, as the passages were numbered. A number that names no answering passage,
  // or names one twice, is dropped: the grades alone still decide what is an answer.
  const order = [...new Set(best.map((n) => n - 1))].filter((i) => (grades[i] ?? 0) >= 2);
  return { grades, best: order };
}

const gradeOnce: Grader = async (question, passages) => {
  const openai = observeOpenAI(modelClient(), { generationName: "search-grade" });
  const list = passages.map((passage, i) => `[${i + 1}] ${passage.source} > ${passage.path}\n${passage.text}`).join("\n\n");
  const completion = await openai.chat.completions.create({
    temperature: 0,
    ...shortStage("grade"),
    messages: [
      { role: "system", content: GRADER_PROMPT },
      { role: "user", content: `Question: ${question}\n\n${passages.length} passages, so return exactly ${passages.length} grades:\n\n${list}` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "grades",
        strict: true,
        schema: {
          type: "object",
          properties: {
            grades: { type: "array", items: { type: "integer", enum: [0, 1, 2, 3] }, minItems: passages.length, maxItems: passages.length },
            best: { type: "array", items: { type: "integer" } }
          },
          required: ["grades", "best"],
          additionalProperties: false
        }
      }
    }
  });
  return readGrades(completion.choices[0], passages.length);
};

export const gradePassages: Grader = retryOnMiscount(gradeOnce);
