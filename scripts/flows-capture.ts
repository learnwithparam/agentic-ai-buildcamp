// npm run flows:capture: asks each canvas example's question through the running app, as the
// person who asks it, then reads that turn's trace back from Langfuse and writes its hops to
// docs/flows/<checkpoint>/<example>.json. lwp-canvas draws those files (bun run buildcamp-flows).
// Needs the app running (npm run dev). Pass a checkpoint name to label the folder: the default is main.
//
//   npm run flows:capture            every example, into docs/flows/main
//   npm run flows:capture -- 21 dose one example, into docs/flows/21

import "../src/server/load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { hopsOf, type Observation } from "./flows";
import { APP, sessionHeader, signIn } from "./sign-in";

const ANA = "ana.rivera@pharma-a.example.com";
const CHIDI = "chidi.okafor@pharma-b.example.com";
export const EXAMPLES = [
  { id: "dose", email: ANA, who: "A Pharma A doctor in the US", ask: "What is the CardioNex dose for a patient with eGFR of 24 mL/min who is not on dialysis?" },
  { id: "child", email: ANA, who: "A Pharma A doctor in the US", ask: "What mg/kg dose of CardioNex should I prescribe for a 9-year-old child with HFrEF?" },
  { id: "tenant", email: CHIDI, who: "Chidi Okafor, a Pharma B doctor in the US", ask: "What is the CardioNex dose for a patient with eGFR 24 mL/min who is not on dialysis?" },
];

const root = path.resolve(import.meta.dirname, "..");


async function ask(email: string, question: string): Promise<string> {
  const cookie = sessionHeader(await signIn(email));
  const created = await fetch(`${APP}/api/threads`, { method: "POST", headers: { Cookie: cookie, Origin: APP }, signal: AbortSignal.timeout(60_000) });
  const { thread_id: threadId } = (await created.json()) as { thread_id: string };
  const response = await fetch(`${APP}/api/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id: randomUUID(), type: "human", content: question }] }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw new Error(`the stream answered ${response.status}`);
  for await (const _ of response.body) void _; // the turn is done when the stream ends
  return threadId;
}

// Langfuse indexes a trace's spans and their inputs a few seconds apart, so the turn is polled
// until the root's reply, the router's input and (on an answer) the citation check are all in.
// The session id of a chat trace is its thread id.
async function spansOf(api: LangfuseClient["api"], threadId: string): Promise<Observation[]> {
  for (let tries = 0; tries < 30; tries++) {
    const page = await api.observations.getMany({ sessionId: threadId, limit: 100, fields: "core,basic,io" } as never);
    const spans = (page as { data: Observation[] }).data;
    const root = spans.find((o) => o.name === "hcp-medinfo-chat-turn");
    const router = spans.find((o) => o.name === "router" && o.type !== "GENERATION");
    const answered = spans.some((o) => o.name === "agent");
    const cited = spans.find((o) => o.name === "cite");
    if (root?.output && router?.input && spans.some((o) => o.name === "route") && (!answered || cited?.output)) return spans;
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`no finished trace for session ${threadId} after a minute`);
}

// Captures each example into docs/flows/<checkpoint> (under `into`, default the repo) and returns
// the trace id of each. scripts/checkpoints-walk.ts calls it for the tag it walks.
export async function captureFlows(checkpoint = "main", only?: string, into = root): Promise<Array<{ id: string; trace: string | undefined }>> {
  const api = new LangfuseClient().api;
  const folder = path.join(into, "docs/flows", checkpoint);
  mkdirSync(folder, { recursive: true });
  const captured: Array<{ id: string; trace: string | undefined }> = [];
  for (const example of EXAMPLES.filter((each) => !only || each.id === only)) {
    const threadId = await ask(example.email, example.ask);
    const spans = await spansOf(api, threadId);
    const flow = hopsOf(spans);
    const trace = spans[0] && (spans[0] as { traceId?: string }).traceId;
    const file = path.join(folder, `${example.id}.json`);
    writeFileSync(file, `${JSON.stringify({ q: example.ask, who: example.who, tier: flow.tier, trace, captured: new Date().toISOString().slice(0, 10), hops: flow.hops }, null, 2)}\n`);
    console.log(`${example.id}: ${flow.tier}, ${flow.hops.length} hops, trace ${trace}, ${path.relative(into, file)}`);
    captured.push({ id: example.id, trace });
  }
  return captured;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [checkpoint, only] = process.argv.slice(2);
  await captureFlows(checkpoint, only);
}
