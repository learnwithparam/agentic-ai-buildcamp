import type { LangChainMessage, LangGraphInterruptState } from "@assistant-ui/react-langgraph";
import { readEvents } from "../../shared/sse";

// The browser side of the thread API in src/server/routes.ts.
import type { AnswerRun } from "../../shared/run";

export type Me = {
  user: { userId: string; name: string; email: string; tenantId: string; country: string; roles: string[] };
  company: { name: string; medicines: string[] };
};

// The session cookie goes with every request by itself. When it has ended, start a new sign-in
// and come back to this page.
export function signIn() {
  window.location.assign(`/api/auth/sign-in?returnTo=${encodeURIComponent(window.location.pathname)}`);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, init);
  if (response.status === 401) {
    signIn();
    throw new Error("Signed out");
  }
  return response;
}

// Signed in, signed out, or signed in but not allowed (no company or no country on the account).
export async function loadMe(): Promise<{ me: Me } | { signedOut: true } | { refused: string }> {
  const response = await fetch("/api/me", { signal: AbortSignal.timeout(10_000) });
  if (response.status === 401) return { signedOut: true };
  if (response.status === 403) return { refused: ((await response.json()) as { error: string }).error };
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return { me: (await response.json()) as Me };
}

// Ends the session here, then at Keycloak, so the next sign-in asks for the password again.
export async function signOut() {
  const response = await fetch("/api/auth/sign-out", { method: "POST" });
  const { redirectTo } = (await response.json()) as { redirectTo: string };
  window.location.assign(redirectTo);
}

// Lesson 13: the chat sends questions only. A paused draft is decided in the inbox.
type SendConfig = { abortSignal: AbortSignal };
type ServerEvent = { event: string; data: unknown };

// Lesson 22: the insights page keeps its threads under /api/insights, with the same shape.
export async function createThread(base = "/api"): Promise<{ externalId: string }> {
  const response = await api(`${base}/threads`, { method: "POST", signal: AbortSignal.timeout(10_000) });
  const body = (await response.json()) as { thread_id?: string; error?: string };
  if (!response.ok || !body.thread_id) throw new Error(body.error ?? `The server answered ${response.status}`);
  return { externalId: body.thread_id };
}

export async function loadThread(threadId: string, base = "/api") {
  const response = await api(`${base}/threads/${threadId}/state`, { signal: AbortSignal.timeout(10_000) });
  return (await response.json()) as { messages: LangChainMessage[]; interrupts: LangGraphInterruptState[]; runs?: Record<string, AnswerRun> };
}

function textOf(message: LangChainMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// The server-sent events of one turn, read by src/shared/sse.ts.
export async function* streamRun(
  threadId: string,
  messages: LangChainMessage[],
  config: SendConfig,
  base = "/api"
): AsyncGenerator<ServerEvent> {
  const body = {
    messages: messages
      .filter((message) => message.type === "human")
      .map((message) => ({ id: message.id ?? crypto.randomUUID(), type: "human", content: textOf(message) }))
  };
  const response = await api(`${base}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: config.abortSignal
  });
  if (response.status === 409) {
    yield { event: "error", data: { message: ((await response.json()) as { error: string }).error } };
    return;
  }
  if (!response.ok || !response.body) {
    yield { event: "error", data: { message: "The agent is not reachable. Is the server running?" } };
    return;
  }
  yield* readEvents(response.body);
}

// ---------- Lesson 13: the review inbox (src/server/routes.ts) ----------

export type ReviewItem = {
  id: string;
  kind: "draft" | "adverse_event" | "email" | "outreach";
  question: string;
  body: string;
  createdAt: string;
  dueAt: string;
  status: "waiting" | "approved" | "rejected" | "filed" | "dismissed";
  decidedAt: string | null;
  note: string | null;
};

export async function loadInbox(): Promise<{ reviewer: boolean; items: ReviewItem[] }> {
  const response = await api("/api/inbox", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return (await response.json()) as { reviewer: boolean; items: ReviewItem[] };
}

export async function decide(itemId: string, decision: ReviewItem["status"], note: string): Promise<ReviewItem> {
  const response = await api(`/api/inbox/${encodeURIComponent(itemId)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, note: note || undefined }),
    signal: AbortSignal.timeout(60_000)
  });
  const body = (await response.json()) as ReviewItem & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The server answered ${response.status}`);
  return body;
}

// ---------- Lesson 14: the email editor and the rep board (src/server/routes.ts) ----------

export type Claim = { claimId: string; docId: string; section: string; country: string; text: string };
export type SentenceCheck = { sentence: string; verdict: "APPROVED" | "NOT_APPROVED_IN_COUNTRY" | "UNAPPROVED_CLAIM"; claim?: Claim; suggestion?: Claim };
export type Draft = { draftId: string; brandId: string; country: string; title: string; sentences: string[] };
// The inbox item a flagged result became, and its status: the same content checked again is the same item.
type ItemRef = { itemId: string | null; itemStatus: ReviewItem["status"] | null };
export type FactCheck = { country: string; checks: SentenceCheck[]; report: string } & ItemRef;
export type HcpRecord = {
  profile: { hcpId: string; country: string; specialty: string; emailConsent: boolean; preferredChannel: string };
  sends: Array<{ sendId: string; team: string; campaign: string; sentAt: string }>;
  calls: Array<{ callId: string; loggedAt: string; note: string }>;
  notes: Array<{ noteId: string; rep: string; loggedAt: string; note: string }>;
  samples: Array<{ requestId: string; brandId: string; status: string; requestedAt: string }>;
};
export type OutreachPlan = { hcpId: string | null; outcome: "INSUFFICIENT_CONTEXT" | "HOLD_OUTREACH" | "NEEDS_APPROVAL"; step: string | null; email: string[] | null; report: string } & ItemRef;

async function send<T>(path: string, body?: unknown): Promise<T> {
  const response = await api(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000)
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `The server answered ${response.status}`);
  return json;
}

export const loadDrafts = () => send<{ drafts: Draft[] }>("/api/drafts");
export const factCheck = (request: { draftId: string } | { text: string; country: string }) => send<FactCheck>("/api/fact-check", request);
export const loadHcps = () => send<{ hcps: HcpRecord[] }>("/api/hcps");
export const planOutreach = (query: string) => send<OutreachPlan>("/api/outreach/plan", { query });

// Lesson 15. A hand-off: which agent took the work, each state its task passed through, and the report.
export type Handoff = { contextId: string; agent: string | null; tasks: Array<{ id: string; state: string }>; itemId: string | null; report: string };
export const handOff = (query: string) => send<Handoff>("/api/handoffs", { query });

// An agent's public card, read from its well-known path like any other A2A client would.
export type AgentCardView = {
  name: string;
  description: string;
  skills: Array<{ id: string; name: string; description: string; examples: string[] }>;
  securitySchemes: Record<string, { openIdConnectSecurityScheme?: { description?: string; openIdConnectUrl?: string } }>;
};
export const loadCard = async (path: string) => {
  const response = await fetch(path, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The agent card answered ${response.status}`);
  return (await response.json()) as AgentCardView;
};

// Lesson 16. The event inbox: what came in for the company, and what each event started.
export type EventView = {
  eventId: string;
  type: "label.in_force" | "email.received" | "draft.uploaded" | "call.logged";
  occurredAt: string;
  deliveries: number;
  status: "queued" | "handled" | "failed";
  outcome: "HANDLED" | "INSUFFICIENT_CONTEXT" | null;
  report: string | null;
  itemIds: string[];
  error: string | null;
  receivedAt: string;
  handledAt: string | null;
};
export const loadEvents = () => send<{ events: EventView[] }>("/api/events");

// Lesson 17. The nightly sweep: its limits, today's spend, and every run with what it left in the inbox.
export type SweepControls = { paused: boolean; budgetUsd: number; changedBy: string | null; changedAt: string | null };
export type SweepRunView = {
  runId: string;
  trigger: "schedule" | "person";
  requestedBy: string | null;
  instruction: string | null;
  status: "running" | "done" | "budget_stop" | "paused" | "failed";
  steps: number;
  spentUsd: number | null;
  report: string | null;
  itemIds: string[];
  traceId: string | null;
  failed: boolean;
  startedAt: string;
  finishedAt: string | null;
};
export type SweepView = { controls: SweepControls; spentUsd: number | null; runs: SweepRunView[] };
export const loadSweep = () => send<SweepView>("/api/sweep");
export const pauseSweep = (paused: boolean) => send<{ controls: SweepControls }>("/api/sweep/pause", { paused });
export const runSweepNow = (request: { instruction?: string; today?: string }) => send<{ runId: string }>("/api/sweep/run", request);
