import type { LangChainMessage, LangGraphInterruptState } from "@assistant-ui/react-langgraph";

// The browser side of the thread API in src/server/routes.ts.

export type Me = {
  user: { userId: string; name: string; email: string; tenantId: string; country: string };
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

type SendConfig = { command?: { resume?: unknown }; abortSignal: AbortSignal };
type ServerEvent = { event: string; data: unknown };

export async function createThread(): Promise<{ externalId: string }> {
  const response = await api("/api/threads", { method: "POST", signal: AbortSignal.timeout(10_000) });
  const body = (await response.json()) as { thread_id: string };
  return { externalId: body.thread_id };
}

export async function loadThread(threadId: string) {
  const response = await api(`/api/threads/${threadId}/state`, { signal: AbortSignal.timeout(10_000) });
  return (await response.json()) as { messages: LangChainMessage[]; interrupts: LangGraphInterruptState[] };
}

function textOf(message: LangChainMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// Reads the server-sent events one block at a time: "event: name", then "data: {json}", then a blank line.
export async function* streamRun(
  threadId: string,
  messages: LangChainMessage[],
  config: SendConfig
): AsyncGenerator<ServerEvent> {
  const body = config.command?.resume
    ? { command: { resume: config.command.resume } }
    : {
        messages: messages
          .filter((message) => message.type === "human")
          .map((message) => ({ id: message.id ?? crypto.randomUUID(), type: "human", content: textOf(message) }))
      };
  const response = await api(`/api/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: config.abortSignal
  });
  if (!response.ok || !response.body) {
    yield { event: "error", data: { message: "The agent is not reachable. Is the server running?" } };
    return;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data) yield { event: name, data: JSON.parse(data) };
      end = buffer.indexOf("\n\n");
    }
  }
}
