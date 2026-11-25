import { randomUUID } from "node:crypto";
import type { Me, ReviewItem } from "../client/chat/api";
import type { StreamEvent } from "../shared/messages";
import { readEvents } from "../shared/sse";
import { CliError } from "./config";
import { SESSION_ENDED } from "./session";

// Lesson 19. The CLI calls the same routes as the chat page (src/server/routes.ts), with the
// doctor's token as a Bearer header instead of the session cookie. There is no CLI API: whatever
// the server refuses the browser, it refuses here too.

export type { Me, ReviewItem };
export type Inbox = { reviewer: boolean; items: ReviewItem[] };
export type Decision = "approved" | "rejected" | "filed" | "dismissed";

// Every string from the server is text someone else wrote: another doctor's question, a model's
// answer. A terminal obeys control characters, so an escape sequence in that text could rewrite
// the screen, hide a line or set the clipboard. They are removed here, once, before anything is
// shown; new lines and tabs stay.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function clean<T>(value: T): T {
  if (typeof value === "string") return value.replace(CONTROL, "") as T;
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)])) as T;
  return value;
}

export function createApi(appUrl: string, token: () => Promise<string>) {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, appUrl), { ...init, headers: { ...init.headers, Authorization: `Bearer ${await token()}` } });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`${appUrl} is not reachable. Is the app running?`);
    }
    if (response.status === 401) throw new CliError(SESSION_ENDED);
    return response;
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await call(path, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = clean((await response.json().catch(() => ({}))) as T & { error?: string });
    if (!response.ok) throw new CliError(body.error ?? `The server answered ${response.status}.`);
    return body;
  }

  return {
    me: () => json<Me>("/api/me"),
    inbox: () => json<Inbox>("/api/inbox"),
    decide: (itemId: string, decision: Decision, note?: string) =>
      json<ReviewItem>(`/api/inbox/${encodeURIComponent(itemId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note ? { decision, note } : { decision })
      }),
    startThread: async () => (await json<{ thread_id: string }>("/api/threads", { method: "POST" })).thread_id,
    // One question on a thread, as the events the chat page reads. A thread that waits for a
    // reviewer takes no new question; the server says so, and that is the error shown.
    async *ask(threadId: string, question: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      const response = await call(`/api/threads/${encodeURIComponent(threadId)}/runs/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: randomUUID(), type: "human", content: question }] }),
        signal
      });
      if (!response.ok || !response.body) {
        const body = clean((await response.json().catch(() => ({}))) as { error?: string });
        throw new CliError(body.error ?? `The server answered ${response.status}.`);
      }
      for await (const event of readEvents(response.body)) yield clean(event);
    }
  };
}

export type Api = ReturnType<typeof createApi>;
