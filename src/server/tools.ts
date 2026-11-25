import type OpenAI from "openai";
import { observe, updateActiveObservation } from "@langfuse/tracing";
import { approvedCountries, searchLabels, TODAY, type LabelSection } from "./labels";
import { readableDocuments } from "./permissions";
import { TENANTS, type Identity } from "./users";

type ToolResult = Record<string, unknown>;

export { TODAY };

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_desk_rules",
      description: "Read the desk rules: today's date, the company and medicines this desk covers, the asker's country, and how to cite.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "search_labels",
      description: "Search the label library: prescribing information, trial summaries, the FAQ and the safety procedure.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up, with the medicine and country when known." }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

// Lesson 11: both tools answer for the signed-in user. The company, its medicines and the
// country come from the token, so no question and no prompt can change them.
// Lesson 16: an event can set the day the desk answers for, so the rules and the search say
// which label is in force on that day.
function deskRules(user: Identity, today: string): ToolResult {
  const countries = approvedCountries(user.tenantId, today);
  return {
    ok: true,
    company: user.tenantId,
    medicines: TENANTS[user.tenantId]?.medicines ?? [],
    asker_country: user.country,
    approved_in_asker_country: countries.includes(user.country),
    today,
    rules: [
      "Answer only from label text returned by search_labels whose status is active: that text is in force today.",
      "Cite every fact as [doc_id, section], for example [cardionex-uspi-v2, 2.2]."
    ]
  };
}

// Lesson 20. How search_labels finds sections. The server and the dataset runner plug in the
// pgvector index over the label PDFs (src/server/rag/search.ts, connectLabelIndex); until then,
// and in the tests that run with no database, it scores the Markdown excerpts by shared words.
export type LabelSearch = (query: string, readable: ReadonlySet<string>, limit: number, today: string) => Promise<LabelSection[]>;

let search: LabelSearch = async (query, readable, limit, today) => searchLabels(query, readable, limit, today);

export function useLabelSearch(next: LabelSearch) {
  search = next;
}

async function labelSearch(input: { query: string }, user: Identity, today: string): Promise<ToolResult> {
  const readable = await readableDocuments(user);
  return {
    ok: true,
    results: (await search(input.query, readable, 4, today)).map((hit) => ({
      doc_id: hit.docId,
      section: hit.section,
      title: hit.title,
      status: hit.status,
      effective_date: hit.effectiveDate,
      country: hit.country,
      text: hit.text
    }))
  };
}

// The tool spans record what the model asked for and which company and country it was answered
// for. The doctor's name and email are not in the trace (src/server/trace-identity.test.ts).
const asker = (user: Identity) => ({ tenantId: user.tenantId, country: user.country });
const getDeskRulesTool = observe(
  (user: Identity, today: string) => {
    updateActiveObservation({ input: { asker: asker(user), today } }, { asType: "tool" });
    return deskRules(user, today);
  },
  { name: "get_desk_rules", asType: "tool", captureInput: false }
);
const searchLabelsTool = observe(
  (input: { query: string }, user: Identity, today: string) => {
    updateActiveObservation({ input: { ...input, asker: asker(user), today } }, { asType: "tool" });
    return labelSearch(input, user, today);
  },
  { name: "search_labels", asType: "tool", captureInput: false }
);

export async function executeTool(name: string, input: Record<string, unknown>, user: Identity, today = TODAY): Promise<ToolResult> {
  switch (name) {
    case "get_desk_rules":
      return getDeskRulesTool(user, today);
    case "search_labels":
      return searchLabelsTool({ query: String(input.query ?? "") }, user, today);
    default:
      return { ok: false, error: `Unsupported tool: ${name}` };
  }
}
