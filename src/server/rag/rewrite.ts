import { observeOpenAI } from "@langfuse/openai";
import { modelClient, shortStage } from "../gateway";
import { timed } from "../ops/meter";

// Lesson 20. "How long do I have to wait when switching?" means nothing to a search on its own:
// no medicine, no drug to switch from. When the doctor has said things before, the model writes
// the question out in full from what they said ("How long after the last ACE inhibitor dose can
// CardioNex be started?"). A first question goes to the search as it is, with no model call.

// checkpoint-sync:begin rewrite-prompt
export const REWRITE_PROMPT = `Rewrite the doctor's latest question so it can be understood with no conversation before it.
Name the medicine, the other drug and the patient details the earlier turns give. Keep every number as it is.
Add nothing the doctor did not say, and do not answer the question. If it already stands alone, return it unchanged.
Reply with the question only.`;
// checkpoint-sync:end rewrite-prompt

export type Turn = { role: "user" | "assistant"; content: string };

export async function standaloneQuery(query: string, earlier: Turn[]): Promise<string> {
  const said = earlier.filter((turn) => turn.content.trim()).slice(-6);
  if (!said.length) return query;
  const openai = observeOpenAI(modelClient(), { generationName: "search-rewrite" });
  const completion = await timed("query_rewrite", () => openai.chat.completions.create({
    temperature: 0,
    ...shortStage("rewrite"),
    messages: [
      { role: "system", content: REWRITE_PROMPT },
      {
        role: "user",
        content: `Earlier turns:\n${said.map((turn) => `${turn.role === "user" ? "Doctor" : "Desk"}: ${turn.content}`).join("\n")}\n\nLatest question: ${query}`
      }
    ]
  }));
  const rewritten = completion.choices[0]?.message.content?.trim();
  if (!rewritten) throw new Error("The search rewriter returned nothing.");
  return rewritten;
}
