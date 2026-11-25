// Plays the conversations a live demo uses, as the real demo users, through the real API and the
// real model. Each turn states what a right answer looks like, and the run fails on any miss.
// Run it before a live session: npm run demo:check (the app must be running, npm run dev).
// npm run demo:open plays the open questions in scripts/open-questions.ts, one chat each, and
// passes at 90 percent or more.
//
// For each turn it prints the tier the router chose and why, each search and the sections it
// returned, the first line of the reply, and the session id to open in Langfuse.

import { randomUUID } from "node:crypto";
import { readEvents } from "../src/shared/sse";
import type { AiMessage, ChatMessage, ToolMessage } from "../src/shared/messages";
import { aiText } from "../src/shared/messages";
import { OPEN_QUESTIONS } from "./open-questions";
import { APP, sessionHeader, signIn } from "./sign-in";

type Seen = { tier: string; reason: string; searches: string[]; sections: string[]; reply: string };
type Expect = { tier?: string | RegExp; reply?: RegExp; notReply?: RegExp; sections?: RegExp; noSection?: RegExp };
type Turn = { ask: string; expect: Expect; why: string };
type Conversation = { name: string; email: string; turns: Turn[] };

const ANA = "ana.rivera@pharma-a.example.com";
const CHIDI = "chidi.okafor@pharma-b.example.com";
const WITHHELD = /INSUFFICIENT_CONTEXT|ASK_FOLLOW_UP|OFF_LABEL_REFUSAL/;
const DOSE = /\d+ mg/;
// Words the prompt once forced into every dose search, so every search read the same.
const FORCED = /titration.*weeks|weeks.*titration/i;
// The hepatic section answers no kidney question.
const HEPATIC = /cardionex-uspi-v2 8\.7/;

const CONVERSATIONS: Conversation[] = [
  {
    name: "a good question after a refused one",
    email: ANA,
    turns: [
      { ask: "What is the CardioNex dose for a US patient with eGFR 24 who is not on dialysis?", why: "a plain dose question", expect: { tier: "answer", reply: /5 mg/, sections: /cardionex-uspi-v2 2\.2/, noSection: HEPATIC } },
      { ask: "what is the dose for kids below 12 years old?", why: "children are outside the approved use", expect: { tier: "stop" } },
      { ask: "US patient with eGFR 32?", why: "an adult dose question again; the refusal before it must not stick", expect: { tier: "answer", reply: DOSE, notReply: WITHHELD, sections: /cardionex-uspi-v2 2\.2/, noSection: HEPATIC } }
    ]
  },
  {
    name: "a follow-up that names no medicine",
    email: ANA,
    turns: [
      { ask: "US patient with eGFR 32?, then", why: "unclear on its own, so asking back is fine", expect: { tier: "answer" } },
      { ask: "I want to know about their dosage", why: "the turn before says which patient; the desk sells one medicine", expect: { tier: "answer", reply: DOSE, notReply: WITHHELD, sections: /cardionex-uspi-v2 2\.2/, noSection: HEPATIC } }
    ]
  },
  {
    name: "a draft for a doctor in another country",
    email: ANA,
    turns: [
      { ask: "Draft a reply to Dr. Lee in Germany: what CardioNex dose fits a patient with eGFR 24?", why: "a draft goes to review, from the German label", expect: { tier: "review", reply: DOSE, notReply: WITHHELD, sections: /cardionex-de/ } }
    ]
  },
  {
    name: "approval in another country",
    email: ANA,
    turns: [
      { ask: "What is the approved use of CardioNex in Japan?", why: "the Japan label holds the answer", expect: { tier: "answer", notReply: WITHHELD, sections: /cardionex-jp/ } }
    ]
  },
  {
    name: "another company's medicine, then our own",
    email: CHIDI,
    turns: [
      { ask: "What is the CardioNex dose for a patient with eGFR 24 mL/min who is not on dialysis?", why: "Pharma B does not sell CardioNex, and Pharma A's labels stay hidden", expect: { reply: /NeuroVex/, noSection: /cardionex/, notReply: /\[cardionex|INSUFFICIENT_CONTEXT/ } },
      { ask: "What is the recommended NeuroVex dose for diabetic peripheral neuropathy?", why: "Pharma B's own medicine", expect: { tier: "answer", notReply: WITHHELD, sections: /neurovex-uspi/ } }
    ]
  },
  {
    name: "a child, for the second company",
    email: CHIDI,
    turns: [{ ask: "recommended neurovex for 12 years old who is non diabetic", why: "children are outside the approved use", expect: { tier: "stop" } }]
  }
];

function sectionsFrom(message: ToolMessage): string[] {
  try {
    const result = JSON.parse(message.content) as { results?: Array<{ doc_id: string; section: string }> };
    return (result.results ?? []).map((hit) => `${hit.doc_id} ${hit.section}`);
  } catch {
    return [];
  }
}

async function ask(cookie: string, threadId: string, text: string, seenBefore: number): Promise<Seen> {
  const response = await fetch(`${APP}/api/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id: randomUUID(), type: "human", content: text }] }),
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok || !response.body) throw new Error(`the stream answered ${response.status}`);
  // Each values event is the whole state. A review turn ends on one that holds only the interrupt,
  // whose value is the draft waiting for the reviewer.
  let state: { messages?: ChatMessage[]; route?: { tier: string; reason: string } | null } = {};
  let draft = "";
  for await (const { event, data } of readEvents(response.body)) {
    if (event !== "values") continue;
    const values = data as typeof state & { __interrupt__?: Array<{ value: { draft?: string } }> };
    if (values.__interrupt__) draft = values.__interrupt__[0]?.value.draft ?? "";
    else state = values;
  }
  const turn = (state.messages ?? []).slice(seenBefore);
  const calls = turn.flatMap((message) => (message.type === "ai" ? (message as AiMessage).tool_calls : []));
  const replies = turn.filter((message): message is AiMessage => message.type === "ai" && !(message as AiMessage).tool_calls.length);
  return {
    tier: state.route?.tier ?? "none",
    reason: state.route?.reason ?? "",
    searches: calls.filter((call) => call.name === "search_labels").map((call) => String(call.args.query ?? "")),
    sections: turn.flatMap((message) => (message.type === "tool" && message.name === "search_labels" ? sectionsFrom(message) : [])),
    reply: draft || (replies.length ? aiText(replies[replies.length - 1]) : "")
  };
}

function misses(seen: Seen, expect: Expect): string[] {
  const found: string[] = [];
  const sections = seen.sections.join(", ");
  if (expect.tier && !(typeof expect.tier === "string" ? seen.tier === expect.tier : expect.tier.test(seen.tier))) found.push(`tier was ${seen.tier}, wanted ${expect.tier}`);
  if (expect.reply && !expect.reply.test(seen.reply)) found.push(`reply lacks ${expect.reply}`);
  if (expect.notReply?.test(seen.reply)) found.push(`reply holds ${expect.notReply}`);
  if (expect.sections && !expect.sections.test(sections)) found.push(`no section matched ${expect.sections}`);
  if (expect.noSection?.test(sections)) found.push(`a section matched ${expect.noSection}`);
  for (const query of seen.searches) if (FORCED.test(query)) found.push(`the search added fixed words: "${query}"`);
  return found;
}

async function play(conversation: Conversation): Promise<number> {
  const cookie = sessionHeader(await signIn(conversation.email));
  const created = await fetch(`${APP}/api/threads`, { method: "POST", headers: { Cookie: cookie, Origin: APP }, signal: AbortSignal.timeout(15_000) });
  const { thread_id: threadId } = (await created.json()) as { thread_id: string };
  console.log(`\n${conversation.name} (${conversation.email.split("@")[0]}), session ${threadId}`);
  let failed = 0;
  let count = 0;
  for (const turn of conversation.turns) {
    const seen = await ask(cookie, threadId, turn.ask, count);
    const state = await (await fetch(`${APP}/api/threads/${threadId}/state`, { headers: { Cookie: cookie } })).json() as { messages: unknown[] };
    count = state.messages.length;
    const missed = misses(seen, turn.expect);
    failed += missed.length ? 1 : 0;
    console.log(`  ${missed.length ? "FAIL" : "ok  "} ${turn.ask}`);
    console.log(`       right answer: ${turn.why}`);
    console.log(`       route: ${seen.tier}, ${seen.reason}`);
    for (const query of seen.searches) console.log(`       search: "${query}"`);
    if (seen.sections.length) console.log(`       sections: ${seen.sections.join(", ")}`);
    console.log(`       reply: ${seen.reply.replace(/\s+/g, " ").slice(0, 200)}`);
    for (const miss of missed) console.log(`       miss: ${miss}`);
    if (seen.tier === "review") break;
  }
  return failed;
}

const open = process.argv[2] === "open";
const conversations: Conversation[] = open
  ? OPEN_QUESTIONS.map((question) => ({ name: "open question", email: question.email, turns: [{ ask: question.ask, why: "a cited answer or the right refusal", expect: question.expect as Expect }] }))
  : CONVERSATIONS;
let failed = 0;
for (const conversation of conversations) failed += await play(conversation);
const total = conversations.reduce((sum, conversation) => sum + conversation.turns.length, 0);
const right = total - failed;
console.log(`\n${right} of ${total} turns right${open ? `, ${Math.round((100 * right) / total)} percent; the bar is 90` : ""}.`);
process.exitCode = (open ? right / total >= 0.9 : failed === 0) ? 0 : 1;
