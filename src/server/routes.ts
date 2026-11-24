import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { currentUser, type Auth } from "./auth";
import { BUDGET_SPENT_MESSAGE, isBudgetSpent } from "./gateway";
import { readMedinfoThread, runMedinfoTurn } from "./medinfo-agent";
import { TENANTS } from "./users";

// The chat UI talks to these routes. They follow the LangGraph server's thread API,
// so assistant-ui's LangGraph runtime can stream from them.

const runSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), type: z.literal("human"), content: z.string().min(1) }))
    .optional(),
  command: z.object({ resume: z.enum(["approve", "reject"]) }).optional()
});

// Lesson 11. Sign-in, sign-out and the callback live in src/server/auth.ts. Everything here needs a signed-in doctor. The thread owner map keeps
// one doctor out of another's conversation: a thread you did not start does not exist for you.
export function createRoutes(auth: Auth) {
  const routes = Router();
  routes.use("/api", auth.requireUser);

  const threadOwners = new Map<string, string>();

  function ownsThread(threadId: string, userId: string) {
    return threadOwners.get(threadId) === userId;
  }

  // Who is signed in, and the desk they ask: what the page shows in its header.
  routes.get("/api/me", (_request, response) => {
    const user = currentUser(response);
    const tenant = TENANTS[user.tenantId];
    response.json({ user, company: { name: tenant.name, medicines: tenant.medicines } });
  });

  routes.post("/api/threads", (_request, response) => {
    const threadId = randomUUID();
    threadOwners.set(threadId, currentUser(response).userId);
    response.json({ thread_id: threadId });
  });

  routes.get("/api/threads/:threadId/state", async (request, response) => {
    if (!ownsThread(request.params.threadId, currentUser(response).userId)) {
      response.status(404).json({ error: "No such thread." });
      return;
    }
    response.json(await readMedinfoThread(request.params.threadId));
  });

  routes.post("/api/threads/:threadId/runs/stream", async (request, response) => {
    const user = currentUser(response);
    if (!ownsThread(request.params.threadId, user.userId)) {
      response.status(404).json({ error: "No such thread." });
      return;
    }
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success || (!parsed.data.messages?.length && !parsed.data.command)) {
      response.status(400).json({ error: "Send messages or a resume command." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await runMedinfoTurn(
        {
          threadId: request.params.threadId,
          user,
          messages: parsed.data.messages,
          resume: parsed.data.command?.resume
        },
        ({ event, data }) => send(event, data)
      );
    } catch (error) {
      console.error(error);
      // The chat shows replies, not error events, so the doctor reads the reason as the assistant's reply.
      const content = isBudgetSpent(error) ? BUDGET_SPENT_MESSAGE : "The agent could not finish this answer. Please try again.";
      const { messages } = await readMedinfoThread(request.params.threadId).catch(() => ({ messages: [] }));
      send("values", { messages: [...messages, { id: `error-${randomUUID()}`, type: "ai", content, tool_calls: [] }] });
    }
    response.end();
  });

  return routes;
}
