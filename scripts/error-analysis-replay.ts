import path from "node:path";
import { fileURLToPath } from "node:url";

// The recorded error-analysis traffic: one entry per turn, each with the spans the agent emitted.
export const TRAFFIC_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/error-analysis-traffic.json");

export type RecordedSpan = {
  id: string;
  parentId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
};

export type RecordedTurn = { id: string; answer: string; spans: RecordedSpan[] };
