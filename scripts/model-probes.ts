// The small jobs bun run models --measure gives each candidate. A probe passes only when code,
// not a model, agrees with the answer. Each probe returns the pass and what the call cost.

import { CALL_TIMEOUT_MS, OPENROUTER_API, type Role } from "../config/models";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { guardQuery, schemaPrompt } from "../packages/core/src/bi";

export type Probe = { name: string; pass: boolean; costUsd: number };
type Reply = { text: string; costUsd: number };

const KEY = () => process.env.OPENROUTER_API_KEY ?? "";

async function chat(model: string, prompt: string, json: boolean): Promise<Reply> {
  const response = await fetch(`${OPENROUTER_API}/v1/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { authorization: `Bearer ${KEY()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const body = (await response.json()) as {
    choices?: { message: { content: string | null } }[];
    usage?: { cost?: number };
    error?: { message: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `status ${response.status}`);
  return { text: body.choices?.[0]?.message.content ?? "", costUsd: body.usage?.cost ?? 0 };
}

async function fastProbe(model: string): Promise<Probe[]> {
  const prompt =
    'Reply with only JSON like {"brand": "...", "country": "..."}. ' +
    'Text: "OncoX is sold in Germany."';
  const reply = await chat(model, prompt, true);
  const found = /oncox/i.test(reply.text) && /germany/i.test(reply.text);
  return [{ name: "pull two facts into JSON", pass: found, costUsd: reply.costUsd }];
}

const SHAPES = [{ table: "pharma_a.territory_rx_weekly", columns: ["territory", "week", "units"] }];

async function smartProbe(model: string): Promise<Probe[]> {
  const question = "How many units were written in each territory?";
  const reply = await chat(model, schemaPrompt(question, SHAPES), false);
  const sql = reply.text.replace(/```(?:sql)?/gi, "").trim();
  const clean = guardQuery(sql, "pharma_a") === undefined && /group by/i.test(sql);
  return [{ name: "write one guarded select", pass: clean, costUsd: reply.costUsd }];
}

async function judgeProbe(model: string): Promise<Probe[]> {
  const cases = [
    { answer: "The OncoX dose in the United States is 150 mg.", right: true },
    { answer: "The OncoX dose in the United States is 900 mg.", right: false },
  ];
  const found: Probe[] = [];
  for (const item of cases) {
    const prompt =
      "The label says: OncoX dose in the United States is 150 mg. " +
      `Answer to grade: "${item.answer}" ` +
      'Reply with only JSON like {"correct": true}.';
    const reply = await chat(model, prompt, true);
    const said = /"correct"\s*:\s*true/i.test(reply.text);
    found.push({
      name: `grade a ${item.right ? "right" : "wrong"} answer`,
      pass: said === item.right,
      costUsd: reply.costUsd,
    });
  }
  return found;
}

export const PROBES: Partial<Record<Role, (model: string) => Promise<Probe[]>>> = {
  fast: fastProbe,
  smart: smartProbe,
  judge: judgeProbe,
};

// The decide role is not a chat model. It gets the routing questions from the golden set.
export const DECIDE_CASES = HCP_GOLDEN.cases
  .filter((item) => item.intent === "answer" || item.intent === "template")
  .slice(0, 8);
