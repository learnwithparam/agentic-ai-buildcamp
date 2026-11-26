import type OpenAI from "openai";
import { observe, updateActiveObservation } from "@langfuse/tracing";
import {
  approvalStatus,
  checkInteraction,
  findLabelText,
  LABEL_SECTIONS,
  labelVersions,
  readSection,
  searchLabels,
  TODAY,
  trialResults,
  type LabelSection
} from "./labels";
import { companyDocuments, readableDocuments } from "./permissions";
import { standaloneQuery, type Turn } from "./rag/rewrite";
import { TENANTS, type Identity } from "./users";

type ToolResult = Record<string, unknown>;

export { TODAY };

const MEDICINE = { type: "string", description: "The medicine, for example NeuroVex." };
const COUNTRY = { type: "string", description: "Two-letter country code. Leave out for the asker's own country." };

function lookupTool(name: string, description: string, properties: Record<string, { type: string; description: string }>) {
  const required = Object.keys(properties).filter((key) => key !== "country");
  return [
    {
      type: "function" as const,
      function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } }
    }
  ];
}

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_labels",
      description: "Search the label library: prescribing information, trial summaries, the FAQ and the safety procedure.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look up, as a question that stands alone: name the medicine and the patient, never \"what about\" or \"and her dose?\"."
          },
          country: { type: "string", description: "Two-letter code of the country the question is about. Leave out for the asker's own country." }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  ...lookupTool("find_label_text", "Find the exact words in the labels in force, for example to check a quote or find a phrase such as \"36 hours\".", {
    phrase: { type: "string", description: "The words to find, at least four letters." }
  }),
  ...lookupTool("read_section", "Read the full text of one label section, for example to quote it.", {
    doc_id: { type: "string", description: "The document id, for example cardionex-uspi-v2." },
    section: { type: "string", description: "The section number, for example 2.2." }
  }),
  ...lookupTool("label_versions", "List every version of a medicine's label in one country, with its status on today's date and why.", {
    medicine: MEDICINE,
    country: COUNTRY
  }),
  ...lookupTool("approval_status", "Say whether a medicine has a label in force in one country, and what it is approved for there.", {
    medicine: MEDICINE,
    country: COUNTRY
  }),
  ...lookupTool("check_interaction", "Find what the label in force says about taking the medicine with another drug.", {
    medicine: MEDICINE,
    other_drug: { type: "string", description: "The other drug, for example spironolactone." },
    country: COUNTRY
  }),
  ...lookupTool("trial_results", "Quote the trial summary sections about one outcome, for example potassium or dizziness.", {
    medicine: MEDICINE,
    endpoint: { type: "string", description: "The outcome asked about." }
  })
];

// Lesson 20. How search_labels finds sections. The server and the dataset runner plug in the
// hybrid search over the label PDFs (src/server/rag/search.ts, connectLabelIndex). There is no
// quiet fallback: a desk that answers from a word count while its index is down gives a doctor
// worse sections and no sign that anything is wrong. A test that wants word search says so.
export type LabelSearch = (query: string, readable: ReadonlySet<string>, limit: number, today: string) => Promise<LabelSection[]>;

// Lessons 1 to 19 search this way, and the tests with no database use it by name.
export const wordSearch: LabelSearch = async (query, readable, limit, today) => searchLabels(query, readable, limit, today);

let search: LabelSearch = async () => {
  throw new Error("search_labels has no label index. The server connects it at start (connectLabelIndex); run npm run rag:ingest first.");
};

export function useLabelSearch(next: LabelSearch) {
  search = next;
}

// How many sections a search returns. The gold questions need up to five sections for one answer
// (a dose table, its renal row, a warning); docs/measures.md scores the search at five.
export const SEARCH_RESULTS = 5;

// Fix 4. A question about another country searches that country's documents of the doctor's own
// company (OpenFGA can_read_abroad), so "a patient in Germany" finds the German label, not the
// asker's own. Without a country, only the documents the asker may read at home.
export function documentsIn(ids: ReadonlySet<string>, country: string): Set<string> {
  const inCountry = new Set(LABEL_SECTIONS.filter((section) => section.country === country).map((section) => section.docId));
  return new Set([...ids].filter((id) => inCountry.has(id)));
}

type SearchInput = { query: string; country?: string };

// What search_labels runs: the question written out in full when the doctor has said things
// before (src/server/rag/rewrite.ts), then the search. scripts/search-eval.ts measures this.
export async function searchFor(query: string, earlier: Turn[], readable: ReadonlySet<string>, today: string) {
  const asked = await standaloneQuery(query, earlier);
  return { asked, hits: await search(asked, readable, SEARCH_RESULTS, today) };
}

async function labelSearch(input: SearchInput, user: Identity, today: string, earlier: Turn[]): Promise<ToolResult> {
  const country = (input.country ?? "").trim().toUpperCase() || user.country;
  const readable = country === user.country ? await readableDocuments(user) : documentsIn(await companyDocuments(user), country);
  const { asked, hits } = await searchFor(input.query, earlier, readable, today);
  return {
    ok: true,
    country,
    asker_country: country === user.country,
    ...(asked === input.query ? {} : { searched_for: asked }),
    results: hits.map((hit) => ({
      doc_id: hit.docId,
      section: hit.section,
      title: hit.title,
      status: hit.status,
      effective_date: hit.effectiveDate,
      country: hit.country,
      score: hit.score,
      ...(hit.scores ? { scores: hit.scores } : {}),
      text: hit.text
    }))
  };
}

// The tool spans record what the model asked for and which company and country it was answered
// for. The doctor's name and email are not in the trace (src/server/trace-identity.test.ts).
const asker = (user: Identity) => ({ tenantId: user.tenantId, country: user.country });
const searchLabelsTool = observe(
  (input: SearchInput, user: Identity, today: string, earlier: Turn[]) => {
    updateActiveObservation({ input: { ...input, asker: asker(user), today, earlier_turns: earlier.length } }, { asType: "tool" });
    return labelSearch(input, user, today, earlier);
  },
  { name: "search_labels", asType: "tool", captureInput: false }
);

// Fix 0. The label lookups a medical information desk uses beside search. They read the
// company's own documents in any country (OpenFGA can_read_abroad) and mark each answer with its
// country, so the agent can say "the Japan label says". Another company's documents never appear.
const LOOKUPS = ["find_label_text", "read_section", "label_versions", "approval_status", "check_interaction", "trial_results"] as const;
type Lookup = (typeof LOOKUPS)[number];

const sectionOut = (section: LabelSection, user: Identity) => ({
  doc_id: section.docId,
  section: section.section,
  title: section.title,
  status: section.status,
  country: section.country,
  asker_country: section.country === user.country,
  text: section.text
});

async function lookup(name: Lookup, input: Record<string, unknown>, user: Identity, today: string): Promise<ToolResult> {
  const readable = await companyDocuments(user);
  const arg = (key: string) => String(input[key] ?? "").trim();
  const country = (arg("country") || user.country).toUpperCase();
  const covered = (TENANTS[user.tenantId]?.medicines ?? []).map((medicine) => medicine.toLowerCase());
  if (input.medicine !== undefined && !covered.includes(arg("medicine").toLowerCase())) {
    return { ok: true, found: false, note: `This desk has no label for ${arg("medicine")}. It covers ${TENANTS[user.tenantId]?.medicines.join(", ")}.` };
  }
  switch (name) {
    case "find_label_text": {
      const found = findLabelText(arg("phrase"), readable, today);
      return found.length
        ? { ok: true, found: true, matches: found.map((hit) => ({ ...sectionOut(hit, user), text: undefined, snippet: hit.snippet })) }
        : { ok: true, found: false, note: `No label in force has the words "${arg("phrase")}".` };
    }
    case "read_section": {
      const hit = readSection(arg("doc_id"), arg("section"), readable, today);
      return hit ? { ok: true, found: true, ...sectionOut(hit, user) } : { ok: true, found: false, note: `No section ${arg("section")} in ${arg("doc_id")}.` };
    }
    case "label_versions": {
      const versions = labelVersions(arg("medicine"), country, readable, today);
      return { ok: true, country, asker_country: country === user.country, today, versions: versions.map((v) => ({ doc_id: v.docId, status: v.status, effective_date: v.effectiveDate, reason: v.reason })) };
    }
    case "approval_status": {
      const status = approvalStatus(arg("medicine"), country, readable, today);
      return { ok: true, country, asker_country: country === user.country, approved: status.approved, label_in_force: status.docId ?? null, uses: status.uses.map((s) => sectionOut(s, user)) };
    }
    case "check_interaction": {
      const found = checkInteraction(arg("medicine"), arg("other_drug"), country, readable, today);
      return {
        ok: true,
        country,
        label_in_force: found.docId ?? null,
        named_in_label: found.named,
        ...(found.named ? {} : { note: `The label does not name ${arg("other_drug")}. These are its interaction sections.` }),
        sections: found.sections.map((s) => sectionOut(s, user))
      };
    }
    case "trial_results":
      return { ok: true, sections: trialResults(arg("medicine"), arg("endpoint"), readable, today).map((s) => sectionOut(s, user)) };
  }
}

const lookupTools = Object.fromEntries(
  LOOKUPS.map((name) => [
    name,
    observe(
      (input: Record<string, unknown>, user: Identity, today: string) => {
        updateActiveObservation({ input: { ...input, asker: asker(user), today } }, { asType: "tool" });
        return lookup(name, input, user, today);
      },
      { name, asType: "tool", captureInput: false }
    )
  ])
) as Record<Lookup, (input: Record<string, unknown>, user: Identity, today: string) => Promise<ToolResult>>;

const isLookup = (name: string): name is Lookup => (LOOKUPS as readonly string[]).includes(name);

// earlier: what the doctor and the desk said before the latest question, so a follow-up search
// knows which medicine it is about. A caller with no conversation (MCP, a handoff) passes none.
export async function executeTool(name: string, input: Record<string, unknown>, user: Identity, today = TODAY, earlier: Turn[] = []): Promise<ToolResult> {
  switch (name) {
    case "search_labels":
      return searchLabelsTool({ query: String(input.query ?? ""), ...(input.country ? { country: String(input.country) } : {}) }, user, today, earlier);
    default:
      return isLookup(name) ? lookupTools[name](input, user, today) : { ok: false, error: `Unsupported tool: ${name}` };
  }
}
