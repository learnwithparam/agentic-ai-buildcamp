import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { MemorySaver } from "@langchain/langgraph";
import type { FactChecker } from "../src/server/content/fact-check";
import type { OutreachPlanner } from "../src/server/content/outreach";
import { fixtureById } from "../src/server/events/events";
import { createEventHandler } from "../src/server/events/handlers";
import { deliver } from "../src/server/events/send";
import { InlineQueue, MemoryEventStore } from "../src/server/events/store";
import { createEventRouter } from "../src/server/events/webhook";
import { createMedinfoAgent } from "../src/server/medinfo-agent";

// Lesson 16. The event cases go through the real webhook, signed the way a sender signs, on a
// port of this process. Two things differ from the app, both on purpose:
//   - each company's signing secret is made for this run, so a run needs no .env secrets;
//   - events are kept in memory and their jobs run when the case drains the queue, one case at a
//     time with a fresh inbox, so one case's deliveries never count toward another's.

export async function startEvents(agents: { factChecker: FactChecker; outreachPlanner: OutreachPlanner }) {
  const secrets = Object.fromEntries(["pharma_a", "pharma_b"].map((tenant) => [tenant, `whsec_${randomBytes(24).toString("base64")}`]));
  const handle = createEventHandler({ agent: createMedinfoAgent(new MemorySaver()), ...agents });
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let current = { store: new MemoryEventStore(), queue: new InlineQueue() };
  const app = express();
  // The router reads the store and queue of the case running now.
  app.use((request, response, next) => createEventRouter({ secrets, ...current })(request, response, next));
  server.on("request", app);

  // Sends one fixture `deliveries` times as `sender`, running the queue after each, and returns
  // what the last delivery led to: the handled report, the duplicate reply, or the refusal.
  async function send(eventId: string, sender: string, deliveries: number) {
    current = { store: new MemoryEventStore(), queue: new InlineQueue() };
    const event = fixtureById(eventId);
    let report = "";
    for (let n = 1; n <= deliveries; n++) {
      const { status, body } = await deliver(base, sender, secrets[sender], event);
      await current.queue.drain(current.store, handle);
      if (status === 202) {
        const row = await current.store.get(sender, event.event_id);
        report = row?.result?.report ?? `The event failed: ${row?.error ?? "no result"}.`;
      } else report = body.report ?? body.error ?? `The webhook answered ${status}.`;
    }
    return report;
  }

  return { send, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
