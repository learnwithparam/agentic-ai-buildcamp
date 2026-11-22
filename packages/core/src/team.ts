// The team agent is the one door every surface uses. It picks a path, then answers.
// A numbers question goes to the BI tool. Any other question goes to the grounded agent.
import { BRANDS } from "../../../data/catalog/brands";
import type { DocumentType } from "../../../data/catalog/documents";
import { type Person, personNamed } from "../../../data/catalog/people";
import type { AgentResult } from "../../../src/grade";
import { can, canUse, type Verdict } from "./access";
import { recall, remember, requestApproval } from "./approvals";
import { ask } from "./ask";
import { answerData, type WriteQuery } from "./bi";
import { answerGrounded, type Generate } from "./grounded";
import { handle } from "./router";
import type { Tags } from "./telemetry";

export type Models = { generate: Generate; writeQuery: WriteQuery };
export type Agent = (question: string, personName: string) => Promise<AgentResult>;

const DATA_WORDS = ["prescription", "sales", "territor", "dispens", "units"];
const TYPE_WORDS: [string, DocumentType][] = [
  ["safety letter", "safety-letter"],
  ["study", "study-summary"],
  ["faq", "faq"],
];

export function isDataQuestion(question: string): boolean {
  const text = question.toLowerCase();
  return DATA_WORDS.some((word) => text.includes(word));
}

function brandIn(question: string): string | undefined {
  const text = question.toLowerCase();
  return BRANDS.find((brand) => text.includes(brand.name.toLowerCase()))?.name;
}

function typeIn(question: string): DocumentType {
  const text = question.toLowerCase();
  const found = TYPE_WORDS.find(([word]) => text.includes(word));
  if (found === undefined) return "label";
  return found[1];
}

// The wall comes before the work: a refused person never reaches a tool or a model.
function permit(person: Person, question: string): Verdict {
  const tool = isDataQuestion(question) ? "bi" : "documents";
  const use = canUse(person, tool);
  if (!use.allowed) return use;
  const brand = brandIn(question);
  if (brand === undefined) return use;
  return can(person, { brand, type: typeIn(question) });
}

const REMEMBER = "remember ";

// A reply that needs a human waits as an approval. Nothing is sent until someone decides.
async function pauseForHuman(result: AgentResult, person: Person, question: string) {
  if (result.route !== "escalate" && result.route !== "approve") return result;
  const id = await requestApproval(person.name, question);
  return { route: result.route, text: `${result.text} Approval ${id} is waiting.`, citations: [] };
}

export async function askTeam(
  question: string,
  personName: string,
  models: Models,
): Promise<AgentResult> {
  const person = personNamed(personName);
  const tags: Tags = { tenantId: person.tenant, agentName: "team", person: person.name };
  if (question.toLowerCase().startsWith(REMEMBER)) {
    await remember(person.name, question.slice(REMEMBER.length));
    return { route: "template", text: "Noted.", citations: [] };
  }
  const result = await handle(question, tags, async (text) => {
    const verdict = permit(person, text);
    if (!verdict.allowed) return { route: "refuse", text: verdict.reason, citations: [] };
    if (isDataQuestion(text)) return answerData(text, person.tenant, tags, models.writeQuery);
    return answerGrounded(text, tags, models.generate);
  });
  return pauseForHuman(result, person, question);
}

// The live agent. Each model call is one traced call through the single door.
export function liveAgent(): Agent {
  return async (question, personName) => {
    const tags: Tags = { tenantId: personNamed(personName).tenant, agentName: "team" };
    const notes = await recall(personName);
    const memory = notes.length === 0 ? "" : `Notes about this person: ${notes.join(" ")}\n`;
    const models: Models = {
      generate: async (prompt) => (await ask("smart", memory + prompt, tags)).text,
      writeQuery: async (prompt) => (await ask("smart", prompt, tags)).text,
    };
    return askTeam(question, personName, models);
  };
}
