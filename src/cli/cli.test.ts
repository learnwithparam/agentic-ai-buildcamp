import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "ink";
import * as oidc from "openid-client";
import { createElement } from "react";
import type { StreamEvent } from "../shared/messages";
import { clean, createApi } from "./api";
import { CLI_CALLBACK_PORT, CliError } from "./config";
import { accessToken, SESSION_ENDED, SIGNED_OUT, waitForCallback, type Tokens, type TokenStore } from "./session";
import { applyEvent, runTurn, START } from "./turn";
import { InboxScreen, TurnScreen } from "./ui";

// Lesson 19. The CLI's own parts with no server and no model: the screen it works out from the
// stream, the sign-in listener, and when it renews or drops a token. The routes it calls are
// tested with real tokens in src/server/inbox.test.ts.

const ai = (text: string, tools: string[] = []) => ({
  id: "ai-1",
  type: "ai",
  content: text ? [{ type: "text", text }] : [],
  tool_calls: tools.map((name, index) => ({ id: `call-${index}`, name, args: {} }))
});
const answer = "CardioNex 5mg once daily [cardionex-label-2026, 2.1].";

async function* replay(events: StreamEvent[]) {
  yield* events;
}

test("the terminal shows what the agent does, then the answer from the finished thread", async () => {
  const views: string[] = [];
  const view = await runTurn(
    replay([
      { event: "messages/partial", data: [ai("", ["search_labels"])] },
      { event: "messages/partial", data: [ai("CardioNex 5mg")] },
      { event: "values", data: { messages: [{ id: "h-0", type: "human", content: "old" }, ai("An older answer."), { id: "h-1", type: "human", content: "Dose?" }, ai(answer)] } }
    ]),
    (next) => views.push(next.activity ?? next.text)
  );
  assert.deepEqual(views, ["Reading your question", "Searching the labels", "CardioNex 5mg", answer, answer]);
  assert.equal(view.done, true);
  assert.equal(view.waiting, null);
  const screen = renderToString(createElement(TurnScreen, { view }), { columns: 70 });
  assert.match(screen, /cardionex-label-2026, 2\.1/);
  const bold = renderToString(createElement(TurnScreen, { view: { ...view, text: "Take **20 mg** daily." } }), { columns: 70 });
  assert.equal(bold.replace(/\x1b\[[0-9;]*m/g, ""), "Take 20 mg daily.");
});

test("a draft that waits for a reviewer shows the inbox item, never the draft", () => {
  const draft = "REVIEW_REQUIRED\n\nUnchecked draft text.";
  const waiting = { kind: "approval", itemId: "draft-42", draft, question: "Q", dueAt: "2026-11-26T10:00:00.000Z" };
  let view = applyEvent(START, { event: "messages/partial", data: [ai(draft)] });
  view = applyEvent(view, { event: "updates", data: { __interrupt__: [{ id: "i", value: waiting, resumable: true }] } });
  const screen = renderToString(createElement(TurnScreen, { view: { ...view, done: true } }), { columns: 70 });
  assert.match(screen, /medical reviewer checks this answer/);
  assert.match(screen, /draft-42/);
  assert.doesNotMatch(screen, /Unchecked draft text/);
});

test("a doctor who is not a reviewer sees no decision keys", () => {
  const item = { id: "d-1", kind: "draft" as const, question: "Dose?", body: "Draft", createdAt: "", dueAt: "2099-01-01T00:00:00Z", status: "waiting" as const, decidedAt: null, note: null, run: null };
  const render = (reviewer: boolean) =>
    renderToString(createElement(InboxScreen, { inbox: { reviewer, items: [item] }, decide: async () => item }), { columns: 90 });
  assert.match(render(true), /a approve {2}r reject/);
  assert.doesNotMatch(render(false), /approve/);
});

test("the sign-in listener ignores another sign-in's state and takes its own", async () => {
  const callback = waitForCallback("right-state", CLI_CALLBACK_PORT, 5_000);
  await callback.ready;
  const base = `http://127.0.0.1:${CLI_CALLBACK_PORT}/callback`;
  assert.equal((await fetch(`${base}?code=stolen&state=wrong-state`)).status, 400);
  assert.equal((await fetch(`${base}?code=good&state=right-state`)).status, 200);
  assert.equal((await callback.result).searchParams.get("code"), "good");
});

test("a refused sign-in ends the wait with Keycloak's reason", async () => {
  const callback = waitForCallback("s", CLI_CALLBACK_PORT, 5_000);
  await callback.ready;
  await fetch(`http://127.0.0.1:${CLI_CALLBACK_PORT}/callback?state=s&error=access_denied&error_description=User%20cancelled`);
  await assert.rejects(callback.result, (error: Error) => error instanceof CliError && /User cancelled/.test(error.message));
});

function memoryStore(saved: Tokens | null): TokenStore & { saved: Tokens | null } {
  const store = { saved, read: () => store.saved, write: (tokens: Tokens) => void (store.saved = tokens), clear: () => void (store.saved = null) };
  return store;
}
const NOW = 1_800_000_000_000;
const refused = () => {
  throw new oidc.ResponseBodyError("refused", { cause: { error: "invalid_grant" }, response: new Response("{}", { status: 400 }) });
};

test("a token with time left is used, a near-expired one is renewed, an ended session signs out", async () => {
  const fresh = memoryStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 120_000 });
  assert.equal(await accessToken(fresh, refused, NOW), "a1");

  const stale = memoryStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 10_000 });
  const renewed = await accessToken(stale, async (refreshToken) => {
    assert.equal(refreshToken, "r1");
    return { access_token: "a2", token_type: "bearer", expires_in: 300 } as oidc.TokenEndpointResponse;
  }, NOW);
  assert.equal(renewed, "a2");
  assert.equal(stale.saved?.refreshToken, "r1", "a refresh with no new refresh token keeps the old one");

  const ended = memoryStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
  await assert.rejects(accessToken(ended, async () => refused(), NOW), new CliError(SESSION_ENDED));
  assert.equal(ended.saved, null);

  const down = memoryStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
  await assert.rejects(accessToken(down, async () => Promise.reject(new TypeError("fetch failed")), NOW), /not reachable/);
  assert.notEqual(down.saved, null, "Keycloak being down does not sign the doctor out");

  await assert.rejects(accessToken(memoryStore(null), refused, NOW), new CliError(SIGNED_OUT));
});

test("text from the server cannot send the terminal control sequences", () => {
  const hostile = { question: "Dose?\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2J", items: [{ body: "5 mg\u009b31m\nonce daily\tok" }] };
  assert.deepEqual(clean(hostile), { question: "Dose?]52;c;cm0gLXJmIH4=[2J", items: [{ body: "5 mg31m\nonce daily\tok" }] });
});

test("the API client cleans what the inbox and the stream return", async (t) => {
  const escape = "\u001b[2J";
  t.mock.method(globalThis, "fetch", async (url: URL) =>
    url.pathname === "/api/inbox"
      ? Response.json({ reviewer: true, items: [{ question: `Dose?${escape}` }] })
      : new Response(`event: values\ndata: ${JSON.stringify({ messages: [ai(`5 mg${escape}`)] })}\n\n`)
  );
  const api = createApi("http://127.0.0.1:1", async () => "token");
  assert.equal((await api.inbox()).items[0].question, "Dose?[2J");
  const view = await runTurn(api.ask("t-1", "Dose?"), () => {});
  assert.equal(view.text, "5 mg[2J");
});
