/**
 * Run the citation check over answers the agent already gave (lesson 21).
 *
 * Reads, from Langfuse, every turn that searched the labels: the search results and the agent's
 * own answer (the model's text, before any rewrite). Runs checkCitations on each and prints how
 * many fail, by kind, with a link to each failing trace. It makes no model calls.
 *
 *   npm run citations:audit              (every stored turn)
 *   npm run citations:audit -- --since 1d
 */
import "../src/server/load-env";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCitations, type CitationProblem, type RetrievedSection } from "../src/server/citations";
import { env } from "../src/server/env";
import { sinceTime } from "./judge-calibrate";
import { runMain } from "./run-main";

type Observation = { traceId: string; name: string; startTime: string; input?: unknown; output?: unknown };
export type StoredSearch = { query: string; results: RetrievedSection[] };
export type StoredTurn = { traceId: string; asked: string; answer: string; retrieved: RetrievedSection[]; searches: StoredSearch[] };

const AGENT_GENERATION = "OpenAI.chat";
const parse = (value: unknown) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// The answer is the trace's last agent generation that wrote text; a generation that asked for a
// tool has tool_calls instead. The citation-rewrite generation (lesson 21) is named apart, so the
// audit reads what the model wrote first, which is what the check stops.
function answerOf(generation: Observation): string | undefined {
  const output = parse(generation.output);
  if (typeof output === "string") return output;
  const content = (output as { content?: unknown } | null)?.content;
  return typeof content === "string" && content ? content : undefined;
}

function askedOf(generation: Observation): string {
  const messages = (parse(generation.input) as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? [];
  return messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : [])).join("\n");
}

export function storedTurns(searches: Observation[], generations: Observation[]): StoredTurn[] {
  const retrieved = new Map<string, StoredSearch[]>();
  for (const search of [...searches].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const results = (parse(search.output) as { results?: RetrievedSection[] } | null)?.results ?? [];
    const query = String((parse(search.input) as { query?: unknown } | null)?.query ?? "");
    retrieved.set(search.traceId, [...(retrieved.get(search.traceId) ?? []), { query, results }]);
  }
  const latest = new Map<string, Observation>();
  for (const generation of generations) {
    if (generation.name !== AGENT_GENERATION || !retrieved.has(generation.traceId) || answerOf(generation) === undefined) continue;
    const seen = latest.get(generation.traceId);
    if (!seen || generation.startTime > seen.startTime) latest.set(generation.traceId, generation);
  }
  return [...latest.values()].map((generation) => ({
    traceId: generation.traceId,
    asked: askedOf(generation),
    answer: answerOf(generation)!,
    retrieved: retrieved.get(generation.traceId)!.flatMap((search) => search.results),
    searches: retrieved.get(generation.traceId)!
  }));
}

const auth = "Basic " + Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64");

async function observations(query: string): Promise<Observation[]> {
  const rows: Observation[] = [];
  let cursor = "";
  do {
    const route = `/api/public/v2/observations?fields=core,basic,io&limit=100&${query}${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await fetch(`${env.langfuseBaseUrl}${route}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Langfuse observations returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { data: Observation[]; meta?: { cursor?: string } };
    rows.push(...body.data);
    cursor = body.data.length ? encodeURIComponent(body.meta?.cursor ?? "") : "";
  } while (cursor);
  return rows;
}

// Every stored turn that searched the labels, and the project id for trace links.
export async function loadStoredTurns(sinceArg?: string): Promise<{ turns: StoredTurn[]; projectId: string }> {
  const from = sinceTime(sinceArg).toISOString();
  const [searches, generations] = await Promise.all([
    observations(`fromStartTime=${from}&name=search_labels`),
    observations(`fromStartTime=${from}&type=GENERATION&name=${AGENT_GENERATION}`)
  ]);
  const [project] = (await (await fetch(`${env.langfuseBaseUrl}/api/public/projects`, { headers: { authorization: auth } })).json()).data as { id: string }[];
  return { turns: storedTurns(searches, generations), projectId: project.id };
}

export const traceLink = (projectId: string, traceId: string) => `${env.langfuseBaseUrl}/project/${projectId}/traces/${traceId}`;

async function main() {
  const since = process.argv.indexOf("--since");
  const { turns, projectId } = await loadStoredTurns(since === -1 ? undefined : process.argv[since + 1]);
  const failed = turns.map((turn) => ({ turn, problems: checkCitations(turn.answer, turn.retrieved, turn.asked) })).filter((row) => row.problems.length);
  const kinds = new Map<CitationProblem["kind"], number>();
  for (const { problems } of failed) for (const kind of new Set(problems.map((problem) => problem.kind))) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  console.log(`${turns.length} answers checked, ${failed.length} would be stopped.`);
  for (const [kind, count] of kinds) console.log(`  ${kind}: ${count}`);
  for (const { turn, problems } of failed) {
    const first = problems[0];
    const what = "citation" in first ? `[${first.citation}]` : `"${first.quantity}"`;
    console.log(`\n${first.kind} ${what}: ${turn.asked.split("\n").at(-1)?.slice(0, 90)}\n  ${traceLink(projectId, turn.traceId)}`);
  }
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) void runMain(main, { name: "Citations audit" });
