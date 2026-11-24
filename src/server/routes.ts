import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { readMedinfoThread, runMedinfoTurn } from "./medinfo-agent";

// The chat UI talks to these routes. They follow the LangGraph server's thread API,
// so assistant-ui's LangGraph runtime can stream from them.

const runSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), type: z.literal("human"), content: z.string().min(1) }))
    .optional(),
  command: z.object({ resume: z.enum(["approve", "reject"]) }).optional()
});

export const routes = Router();

routes.post("/api/threads", (_request, response) => {
  response.json({ thread_id: randomUUID() });
});

routes.get("/api/threads/:threadId/state", async (request, response) => {
  response.json(await readMedinfoThread(request.params.threadId));
});

routes.post("/api/threads/:threadId/runs/stream", async (request, response) => {
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
        messages: parsed.data.messages,
        resume: parsed.data.command?.resume
      },
      ({ event, data }) => send(event, data)
    );
  } catch (error) {
    console.error(error);
    send("error", { message: "The agent could not finish this answer. Please try again." });
  }
  response.end();
});
