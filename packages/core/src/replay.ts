// Replay plays back replies that were recorded once from a real model.
// A reply is found by a hash of the role and the prompt. A new prompt has no reply yet.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE = join(import.meta.dir, "..", "..", "..", "config", "replay", "answers.json");

export type Recorded = { text: string; inputTokens: number; outputTokens: number };

export class NoRecording extends Error {}

export function recordingKey(role: string, prompt: string): string {
  const text = [role, prompt].join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function readStore(): Record<string, Recorded> {
  if (!existsSync(STORE)) return {};
  return JSON.parse(readFileSync(STORE, "utf8")) as Record<string, Recorded>;
}

export function replayReply(role: string, prompt: string): Recorded {
  const found = readStore()[recordingKey(role, prompt)];
  if (found === undefined) {
    throw new NoRecording(
      "No recorded reply for this prompt. Set LLM_PROVIDER and a key, then run: bun run record",
    );
  }
  return found;
}

export function saveRecording(role: string, prompt: string, reply: Recorded): void {
  const store = readStore();
  store[recordingKey(role, prompt)] = reply;
  const entries = Object.entries(store).sort(([first], [second]) => first.localeCompare(second));
  writeFileSync(STORE, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
}
