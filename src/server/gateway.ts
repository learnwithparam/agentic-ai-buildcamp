import OpenAI from "openai";
import { startActiveObservation } from "@langfuse/tracing";
import { env } from "./env";
import { meteredFetch, timed } from "./ops/meter";

// The one door for every model call (lesson 10). No other file creates a model client or
// calls a model URL; scripts/check-repo.test.ts fails if one does.
//
// Chat calls go through the Langfuse AI gateway. The provider key lives in the gateway's
// OpenRouter connection, not here. Each service has its own gateway key, limited to the
// models it needs and to a daily budget, so the gateway can refuse a call before it costs.
// The gateway records every call with its cost in the "ai-gateway" project, traced or not.

export type Service = "medinfo-app" | "eval-runner";

let current: Service = "medinfo-app";

// The web server is medinfo-app. A script that runs evaluations calls useService("eval-runner")
// first, so its spend shows, and is capped, apart from the app's.
export function useService(service: Service) {
  current = service;
}

function gatewayKey(service: Service) {
  const key = service === "medinfo-app" ? env.gatewayKeyMedinfoApp : env.gatewayKeyEvalRunner;
  const name = service === "medinfo-app" ? "GATEWAY_KEY_MEDINFO_APP" : "GATEWAY_KEY_EVAL_RUNNER";
  if (!key) throw new Error(`${name} is not set. Create the ${service} key in Langfuse under AI Gateway, then add it to .env (lesson 10).`);
  return key;
}

const clients = new Map<Service, OpenAI>();

export function modelClient(): OpenAI {
  let client = clients.get(current);
  if (!client) {
    client = new OpenAI({
      baseURL: `${env.gatewayUrl}/openai/v1`,
      apiKey: gatewayKey(current),
      // A 429 from the gateway means the key's budget is spent. Retrying it only waits, so the SDK
      // retries nothing; retryingOn504 below asks again only when no answer came back.
      maxRetries: 0,
      fetch: withConnection
    });
    clients.set(current, client);
  }
  return client;
}

// Lesson 20. The label search turns text into vectors through the same door and the same key,
// so the gateway records and caps it like any chat call. Every stored vector and every question
// must come from the same model, or their distances mean nothing: rows are keyed by model, so a new
// EMBEDDING_MODEL finds an empty index and the server stops until npm run rag:ingest has run.
// Read here, not in env.ts: this file reaches lesson 10, whose env.ts does not know it.
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

// The most a stage that gives a short answer may write. A cap only stops a runaway answer; each is
// several times what a good answer needs (30 grades and a best list are about 150 tokens). They
// sit here, beside the one door, so a reader sees every cap together.
export const OUTPUT_CAP = { router: 800, rewrite: 400, grade: 1500, judge: 300, claims: 3000 } as const;

// The model for those short stages. It defaults to the chat model; STAGE_MODEL picks a faster one.
export const STAGE_MODEL = process.env.STAGE_MODEL ?? env.openaiModel;

// The settings every short structured stage sends. The chat model reasons before it answers, and
// that thinking counts against max_tokens: measured on 2026-11-27, the grader spent all 1500 on
// reasoning for "Is CardioNex approved in Japan for HFrEF?" and returned no JSON, three runs in a
// row. With low effort asked for, the same question graded on the next run. Spread into the request.
// The claim listing only points at numbered sentences, so it asks for no reasoning: measured on 27
// Nov 2026 over 8 stored answers, its median call fell from 2.7 to 1.4 seconds and as many of its
// claims passed the code checks (9 of 15 against 8 of 14).
export const STAGE_EFFORT: Record<keyof typeof OUTPUT_CAP, "none" | "low"> = { router: "low", rewrite: "low", grade: "low", judge: "low", claims: "none" };
export const shortStage = (stage: keyof typeof OUTPUT_CAP) => ({ model: STAGE_MODEL, max_tokens: OUTPUT_CAP[stage], ...({ reasoning: { effort: STAGE_EFFORT[stage] } } as object) });

export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  return startActiveObservation(
    "embed",
    async (span) => {
      span.update({ model: EMBEDDING_MODEL, input: { count: texts.length } });
      const response = await timed("embedding", () => modelClient().embeddings.create({ model: EMBEDDING_MODEL, input: texts, encoding_format: "float" }));
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
      if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`The embedding model did not return one ${EMBEDDING_DIMENSIONS}-number vector per text.`);
      }
      span.update({ output: { count: vectors.length }, usageDetails: { input: response.usage?.prompt_tokens ?? 0 } });
      return vectors;
    },
    { asType: "embedding" }
  );
}

// The gateway answers 429 spend_limit_exceeded once a key's budget is spent. The doctor sees a
// plain sentence; the amount and the key stay in the gateway's log.
export function isBudgetSpent(error: unknown) {
  return error instanceof OpenAI.APIError && error.status === 429 && error.code === "spend_limit_exceeded";
}

export const BUDGET_SPENT_MESSAGE = "The assistant has reached its usage limit for today. Please try again tomorrow, or contact the medical information desk.";

// The gateway names a model by its connection, then the provider's model id:
// openrouter:openai/gpt-6-luna. The code (and so every trace) keeps the provider's id, which
// Langfuse prices; the door adds the connection on the way out.
export const CONNECTION = "openrouter";

export function withConnectionName(body: string): string {
  const parsed = JSON.parse(body) as { model?: unknown };
  if (typeof parsed.model !== "string" || parsed.model.includes(":")) return body;
  return JSON.stringify({ ...parsed, model: `${CONNECTION}:${parsed.model}` });
}

// A 504 means the gateway gave up before any answer came back, most often while it looked up the
// key in Langfuse on a busy laptop. No answer was sent, so asking again cannot bill twice. Every
// other status, a 429 above all, goes straight back to the caller.
export function retryingOn504(send: typeof fetch, waits = [1000, 3000]): typeof fetch {
  return async (url, init) => {
    for (const wait of waits) {
      const response = await send(url, init);
      if (response.status !== 504) return response;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return send(url, init);
  };
}

// meteredFetch counts a turn's cost and structured-output failures while a turn runs (src/server/ops/meter.ts).
const withConnection: typeof fetch = meteredFetch(
  retryingOn504((url, init) => fetch(url, typeof init?.body === "string" ? { ...init, body: withConnectionName(init.body) } : init))
);

// The behavior decision is a model call that does not go through the gateway, so it is counted
// here, in the same file and by the same meter, instead of being missed.
const decisionsFetch: typeof fetch = meteredFetch((url, init) => fetch(url, init));

// --- The input check. The gateway has no guardrails yet (they are on its roadmap), so the
//     check runs here, before any model call. Each rule is narrow and named; the dataset test
//     proves no real question trips one.
export const OUT_OF_SCOPE_RULES = [
  {
    name: "code",
    pattern: /\b(python|javascript|typescript|sql|bash|html|scrape|scraper|source code|script|program)\b/i,
    reason: "Writing code"
  }
] as const;

export function checkInput(question: string): string | null {
  const rule = OUT_OF_SCOPE_RULES.find((candidate) => candidate.pattern.test(question));
  if (!rule) return null;
  return `OUT_OF_SCOPE: This desk answers questions about our medicines from their approved labels. ${rule.reason} is outside that, so I can't help with it here.`;
}

// --- The behavior decision. The gateway does not carry the Decisions format for OpenRouter
//     (it answers 404 no_route), so this is the one call that still goes straight to the
//     provider. It runs inside a generation, so Langfuse still sees it and its cost.
export type DecisionsRequest = { state: string; questions: Record<string, unknown> };

export async function decide<T>(request: DecisionsRequest): Promise<T> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set. The behavior decision is the one call that goes straight to OpenRouter (lesson 10).");
  }
  return startActiveObservation(
    "behavior-decision",
    async (generation) => {
      generation.update({ model: env.decisionModel, input: request });
      const response = await decisionsFetch(env.decisionsUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.decisionModel, ...request }),
        signal: AbortSignal.timeout(60_000)
      });
      const text = await response.text();
      if (!response.ok) {
        generation.update({ level: "ERROR", statusMessage: `${response.status}`, output: text.slice(0, 500) });
        throw new Error(`Decisions request failed (${response.status}): ${text}`);
      }
      const body = JSON.parse(text) as T & { usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
      generation.update({
        output: body,
        ...(body.usage && {
          usageDetails: { input: body.usage.input_tokens ?? 0, output: body.usage.output_tokens ?? 0 },
          ...(typeof body.usage.cost === "number" && { costDetails: { total: body.usage.cost } })
        })
      });
      return body;
    },
    { asType: "generation" }
  );
}
