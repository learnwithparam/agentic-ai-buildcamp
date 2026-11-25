#!/usr/bin/env node
import { Command } from "commander";
import { Box, render, renderToString } from "ink";
import open from "open";
import * as oidc from "openid-client";
import type { ReactNode } from "react";
import { createApi, type Decision } from "./api";
import { CliError, DEFAULT_APP_URL } from "./config";
import { accessToken, keychainStore, login, logout, signInServer } from "./session";
import { runTurn } from "./turn";
import { AskScreen, InboxList, InboxScreen, ThreadHint, TurnScreen, WhoAmI } from "./ui";

// Lesson 19. medinfo: the HCP Medical Information desk in a terminal. Same sign-in, same routes,
// same permissions as the chat page; only the screen is different.

const program = new Command("medinfo")
  .description("Ask the HCP Medical Information desk from your terminal.")
  .option("--url <url>", "the app's address", process.env.MEDINFO_URL ?? DEFAULT_APP_URL);

const appUrl = () => new URL(program.opts<{ url: string }>().url).origin;

function session() {
  const url = appUrl();
  const store = keychainStore(url);
  let config: Promise<oidc.Configuration> | undefined;
  const server = () => (config ??= signInServer(url));
  const token = () => accessToken(store, async (refreshToken) => oidc.refreshTokenGrant(await server(), refreshToken));
  return { url, store, server, api: createApi(url, token) };
}

// With --json, or when the output is not a terminal (a pipe, a script), print data, not screens.
const plain = (json?: boolean) => json || !process.stdout.isTTY;
const print = (node: ReactNode) => console.log(renderToString(node, { columns: process.stdout.columns || Number(process.env.COLUMNS) || 80 }));

program
  .command("login")
  .description("Sign in with Keycloak in your browser.")
  .option("--no-browser", "print the sign-in address instead of opening it")
  .action(async ({ browser }: { browser: boolean }) => {
    const { server, store, api } = session();
    await login(await server(), store, async (url) => {
      console.log(`Sign in here:\n\n  ${url}\n`);
      if (browser) await open(url).catch(() => console.log("The browser did not open. Copy the address above."));
    });
    print(<WhoAmI me={await api.me()} />);
  });

program
  .command("logout")
  .description("End the sign-in and remove it from the keychain.")
  .action(async () => {
    const { server, store } = session();
    const result = await logout(server, store);
    console.log(
      {
        ended: "Signed out.",
        "local-only": "Signed out on this machine. Keycloak was not reachable, so the session ends when it expires.",
        "not-signed-in": "You were not signed in."
      }[result]
    );
  });

program
  .command("whoami")
  .description("Show who you are signed in as, and for which company.")
  .option("--json", "print JSON")
  .action(async ({ json }: { json?: boolean }) => {
    const me = await session().api.me();
    if (json) return console.log(JSON.stringify(me, null, 2));
    print(<WhoAmI me={me} />);
  });

program
  .command("ask")
  .description("Ask the desk a question.")
  .argument("<question...>", "your question")
  .option("--thread <id>", "carry on an earlier conversation")
  .option("--json", "print the answer as JSON when it is done")
  .action(async (words: string[], { thread, json }: { thread?: string; json?: boolean }) => {
    const { api } = session();
    const threadId = thread ?? (await api.startThread());
    const events = api.ask(threadId, words.join(" "));
    if (plain(json)) {
      const view = await runTurn(events, () => {});
      if (json) return console.log(JSON.stringify({ threadId, answer: view.waiting ? null : view.text, waitingFor: view.waiting }, null, 2));
      return print(
        <Box flexDirection="column" gap={1}>
          <TurnScreen view={view} />
          <ThreadHint threadId={threadId} />
        </Box>
      );
    }
    let failed: Error | undefined;
    const app = render(<AskScreen events={events} threadId={threadId} onEnd={(error) => (failed = error)} />);
    await app.waitUntilExit();
    if (failed) throw failed;
  });

program
  .command("inbox")
  .description("Your review inbox. Reviewers can decide items here.")
  .option("--json", "print JSON")
  .action(async ({ json }: { json?: boolean }) => {
    const { api } = session();
    const inbox = await api.inbox();
    if (json) return console.log(JSON.stringify(inbox, null, 2));
    if (!process.stdout.isTTY || !process.stdin.isTTY) return print(<InboxList inbox={inbox} />);
    await render(<InboxScreen inbox={inbox} decide={(itemId, decision) => api.decide(itemId, decision)} />).waitUntilExit();
  });

const DECIDE: Record<string, Decision> = { approve: "approved", reject: "rejected", file: "filed", dismiss: "dismissed" };

program
  .command("decide")
  .description("Decide one inbox item: approve or reject a draft, email or step; file or dismiss an adverse event.")
  .argument("<itemId>", "the item id from medinfo inbox --json")
  .argument("<decision>", "approve, reject, file or dismiss")
  .option("--note <text>", "a note kept with the decision")
  .action(async (itemId: string, word: string, { note }: { note?: string }) => {
    const decision = DECIDE[word];
    if (!decision) throw new CliError("Decide with one of: approve, reject, file, dismiss.");
    const item = await session().api.decide(itemId, decision, note);
    console.log(`${item.id}: ${item.status}.`);
  });

// A CliError is a sentence for the doctor. Anything else is a bug: say so, and keep the details
// out of the terminal unless MEDINFO_DEBUG is set.
program.parseAsync().catch((error: unknown) => {
  if (error instanceof CliError) console.error(error.message);
  else {
    console.error("Something went wrong in the CLI. Run again with MEDINFO_DEBUG=1 to see the details.");
    if (process.env.MEDINFO_DEBUG) console.error(error);
  }
  process.exitCode = 1;
});
