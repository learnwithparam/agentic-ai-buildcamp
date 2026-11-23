// bun run models reads the live OpenRouter price list for every model in config/model-pool.json,
// writes config/model-catalog.json and prints the model each role would use.
// bun run models --measure also gives every candidate a small job per role, with the real
// provider cost, and writes the cheapest one that passes everything to config/model-choice.json.
// It needs OPENROUTER_API_KEY only for --measure. It never prints a key.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALL_TIMEOUT_MS,
  type Catalog,
  type CatalogEntry,
  type Choice,
  cheapestFor,
  choices,
  modelId,
  NEEDS,
  OPENROUTER_API,
  pool,
  ROLES,
  type Role,
  TOKENS_PER_PRICE_UNIT,
} from "../config/models";
import { decideAmong } from "../packages/core/src/decide";
import { DECIDE_CASES, PROBES, type Probe } from "./model-probes";

const CONFIG = join(import.meta.dir, "..", "config");
const MEASURE = process.argv.includes("--measure");

type Listed = {
  id: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
};

function entryOf(item: Listed): CatalogEntry {
  const params = item.supported_parameters ?? [];
  return {
    input: Number(item.pricing.prompt) * TOKENS_PER_PRICE_UNIT,
    output: Number(item.pricing.completion) * TOKENS_PER_PRICE_UNIT,
    context: item.context_length,
    tools: params.includes("tools"),
    json: params.includes("response_format"),
    image: (item.architecture?.input_modalities ?? []).includes("image"),
  };
}

async function refreshCatalog(): Promise<Catalog> {
  const response = await fetch(`${OPENROUTER_API}/v1/models`, {
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const listed = ((await response.json()) as { data: Listed[] }).data;
  const wanted = new Set(Object.values(pool()).flat());
  const models: Catalog["models"] = {};
  for (const item of listed) if (wanted.has(item.id)) models[item.id] = entryOf(item);
  const fresh = { fetchedAt: new Date().toISOString(), models };
  writeFileSync(join(CONFIG, "model-catalog.json"), `${JSON.stringify(fresh, null, 2)}\n`);
  return fresh;
}

async function decideProbes(): Promise<Probe[]> {
  const found: Probe[] = [];
  const options = {
    answer: "A question about a drug label, a study or sales.",
    template: "Small talk or a question outside medical affairs.",
  };
  for (const item of DECIDE_CASES) {
    const tags = { tenantId: "pharma-a", agentName: "models" };
    const pick = await decideAmong(
      item.question,
      "Which path answers this question?",
      options,
      tags,
    );
    found.push({ name: item.name, pass: pick.choice === item.intent, costUsd: pick.costUsd });
  }
  return found;
}

async function probesFor(role: Role, candidate: string): Promise<Probe[]> {
  if (role === "decide") return decideProbes();
  const probe = PROBES[role];
  return probe === undefined ? [] : probe(candidate);
}

async function measure(role: Role): Promise<Choice | undefined> {
  const results: Choice[] = [];
  for (const candidate of pool()[role]) {
    process.env[`MODEL_${role.toUpperCase()}`] = candidate;
    const probes = await probesFor(role, candidate).catch((error: Error) => {
      console.log(`  ${role.padEnd(6)} ${candidate}  failed: ${error.message}`);
      return [] as Probe[];
    });
    if (probes.length === 0) continue;
    const passRate = probes.filter((probe) => probe.pass).length / probes.length;
    const cost = probes.reduce((sum, probe) => sum + probe.costUsd, 0) / probes.length;
    const line = `${role.padEnd(6)} ${candidate}  pass ${passRate.toFixed(2)}`;
    console.log(`  ${line}  USD ${cost.toFixed(8)} a case`);
    results.push({ id: candidate, passRate, costPerCase: cost });
  }
  results.sort((first, second) => {
    return second.passRate - first.passRate || first.costPerCase - second.costPerCase;
  });
  return results[0];
}

const fresh = await refreshCatalog();
const priced = Object.entries(pool())
  .filter(([role]) => role !== "decide")
  .flatMap(([, ids]) => ids);
const missing = priced.filter((id) => fresh.models[id] === undefined);
if (missing.length > 0) console.log(`Not on the OpenRouter list: ${missing.join(", ")}`);

if (MEASURE) {
  const chosen: Partial<Record<Role, Choice>> = {};
  for (const role of ROLES) {
    const best = await measure(role);
    if (best !== undefined) chosen[role] = best;
    delete process.env[`MODEL_${role.toUpperCase()}`];
  }
  writeFileSync(join(CONFIG, "model-choice.json"), `${JSON.stringify(chosen, null, 2)}\n`);
}

console.log("Role   Model                              Needs       In/Out USD per million");
for (const role of ROLES) {
  const id = modelId(role);
  const entry = fresh.models[id];
  const price = entry ? `${entry.input.toFixed(3)} / ${entry.output.toFixed(3)}` : "per call";
  const needs = NEEDS[role].join(",").padEnd(11);
  const note = choices()[role]
    ? `pass ${choices()[role]?.passRate}`
    : `cheapest: ${cheapestFor(role)}`;
  console.log(`${role.padEnd(6)} ${id.padEnd(34)} ${needs} ${price}  ${note}`);
}
