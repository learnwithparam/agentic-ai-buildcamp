// Read employee.trace/v1 files. The checker reads spans, never the reply.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, MAX_PRICE_AGE_DAYS, PRICES, PRICES_AS_OF } from "../../config/models";
import type { Running } from "./employee";

export type Span = {
  format: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: string;
  end_time: string;
  status: string;
  attributes: Record<string, unknown>;
};

const DAY_MS = 86_400_000;

function traceDirs(employee: Running): string[] {
  const configured = join(employee.dir, employee.toml.contract.traces ?? "traces");
  return [employee.traceDir, configured].filter((folder) => existsSync(folder));
}

export function readRun(employee: Running, runId: string): Span[] {
  for (const folder of traceDirs(employee)) {
    const file = join(folder, `${runId}.jsonl`);
    if (existsSync(file)) return parse(readFileSync(file, "utf8"));
  }
  return [];
}

export function readAll(employee: Running): Span[] {
  const folder = traceDirs(employee)[0];
  if (!folder) return [];
  const traceFiles = readdirSync(folder).filter((file) => file.endsWith(".jsonl"));
  return traceFiles.flatMap((file) => parse(readFileSync(join(folder, file), "utf8")));
}

// A line that is not JSON, or not a span in our format, is skipped rather than failing the check.
function parseLine(line: string): Span[] {
  try {
    const span = JSON.parse(line);
    return span?.format === "employee.trace/v1" ? [span] : [];
  } catch {
    return [];
  }
}

function parse(text: string): Span[] {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.flatMap(parseLine);
}

export const spansNamed = (spans: Span[], name: string) =>
  spans.filter((span) => span.name === name);

export const toolCalls = (spans: Span[]) =>
  spansNamed(spans, "execute_tool").map((span) => String(span.attributes["gen_ai.tool.name"]));

function spanCost(model: string, attributes: Record<string, unknown>): number {
  const cost = costUsd(
    model,
    Number(attributes["gen_ai.usage.input_tokens"] ?? 0),
    Number(attributes["gen_ai.usage.output_tokens"] ?? 0),
    Number(attributes["gen_ai.usage.cache_read.input_tokens"] ?? 0),
  );
  return cost ?? 0;
}

// Spend from the token counts in chat spans and the dated price table. Never read from the
// employee.
export function spendFromSpans(spans: Span[]): { usd: number; unknownModels: string[] } {
  let usd = 0;
  const unknownModels = new Set<string>();
  for (const span of spansNamed(spans, "chat")) {
    const model = String(span.attributes["gen_ai.request.model"] ?? "");
    if (!PRICES[model]) {
      unknownModels.add(model || "(none)");
      continue;
    }
    usd += spanCost(model, span.attributes);
  }
  return { usd, unknownModels: [...unknownModels] };
}

export function priceTableAgeDays(now = new Date()) {
  const ageMs = now.getTime() - new Date(PRICES_AS_OF).getTime();
  return Math.floor(ageMs / DAY_MS);
}

export const priceTableTooOld = (now = new Date()) => priceTableAgeDays(now) > MAX_PRICE_AGE_DAYS;
