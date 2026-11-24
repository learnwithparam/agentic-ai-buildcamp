import type OpenAI from "openai";
import { observe } from "@langfuse/tracing";
import { searchLabels } from "./labels";

type ToolResult = Record<string, unknown>;

// The desk the agent answers for. The dataset fixes "today" so every run sees the same labels in force.
export const DESK = {
  company: "pharma_a",
  brands: ["CardioNex"],
  countries: ["US", "DE", "JP"],
  today: "2026-11-23"
};

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_desk_rules",
      description: "Read the desk rules: today's date, the medicines and countries this desk covers, and how to cite.",
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

// checkpoint-sync:begin tool-bodies
function deskRules(): ToolResult {
  return {
    ok: true,
    ...DESK,
    rules: [
      "Answer only from label text returned by search_labels.",
      "Cite every fact as [doc_id, section], for example [cardionex-uspi-v2, 2.2]."
    ]
  };
}

function labelSearch(input: { query: string }): ToolResult {
  return {
    ok: true,
    results: searchLabels(input.query).map((hit) => ({
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
// checkpoint-sync:end tool-bodies

const getDeskRulesTool = observe(deskRules, { name: "get_desk_rules", asType: "tool" });
const searchLabelsTool = observe(labelSearch, { name: "search_labels", asType: "tool" });

export async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_desk_rules":
      return getDeskRulesTool();
    case "search_labels":
      return searchLabelsTool({ query: String(input.query ?? "") });
    default:
      return { ok: false, error: `Unsupported tool: ${name}` };
  }
}
