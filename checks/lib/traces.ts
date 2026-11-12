// Read employee.trace/v1 files. The checker reads spans, never the reply.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { costUsd, PRICES, PRICES_AS_OF, MAX_PRICE_AGE_DAYS } from "../../config/models";
import type { Running } from "./employee";

export type Span = { format: string; trace_id: string; span_id: string; parent_span_id: string | null; name: string;
  start_time: string; end_time: string; status: string; attributes: Record<string, any> };

function traceDirs(e: Running) {
  return [e.traceDir, join(e.dir, e.toml.contract.traces ?? "traces")].filter((d) => existsSync(d));
}

export function readRun(e: Running, runId: string): Span[] {
  for (const d of traceDirs(e)) {
    const f = join(d, `${runId}.jsonl`);
    if (existsSync(f)) return parse(readFileSync(f, "utf8"));
  }
  return [];
}

export function readAll(e: Running): Span[] {
  const d = traceDirs(e)[0];
  if (!d) return [];
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).flatMap((f) => parse(readFileSync(join(d, f), "utf8")));
}

function parse(text: string): Span[] {
  return text.split("\n").filter((l) => l.trim()).flatMap((l) => {
    try { const s = JSON.parse(l); return s?.format === "employee.trace/v1" ? [s] : []; } catch { return []; }
  });
}

export const spansNamed = (spans: Span[], name: string) => spans.filter((s) => s.name === name);
export const toolCalls = (spans: Span[]) => spansNamed(spans, "execute_tool").map((s) => String(s.attributes["gen_ai.tool.name"]));

// Spend from the token counts in chat spans and the dated price table. Never read from the employee.
export function spendFromSpans(spans: Span[]): { usd: number; unknownModels: string[] } {
  let usd = 0;
  const unknown = new Set<string>();
  for (const s of spansNamed(spans, "chat")) {
    const a = s.attributes;
    const model = String(a["gen_ai.request.model"] ?? "");
    if (!PRICES[model]) { unknown.add(model || "(none)"); continue; }
    usd += costUsd(model, Number(a["gen_ai.usage.input_tokens"] ?? 0), Number(a["gen_ai.usage.output_tokens"] ?? 0), Number(a["gen_ai.usage.cache_read.input_tokens"] ?? 0));
  }
  return { usd, unknownModels: [...unknown] };
}

export function priceTableAgeDays(now = new Date()) {
  return Math.floor((now.getTime() - new Date(PRICES_AS_OF).getTime()) / 86_400_000);
}
export const priceTableTooOld = (now = new Date()) => priceTableAgeDays(now) > MAX_PRICE_AGE_DAYS;
