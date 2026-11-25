import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { currentUser, type Auth } from "./auth";
import { CONTENT_DRAFTS, PROFILES, recordOf } from "./content/records";
import type { FactChecker } from "./content/fact-check";
import type { OutreachPlanner } from "./content/outreach";
import { BUDGET_SPENT_MESSAGE, isBudgetSpent } from "./gateway";
import { visibleHcps } from "./permissions";
import { scrubPhi } from "./phi";
import type { MedinfoAgent } from "./medinfo-agent";
import { DECISIONS, type ReviewItem, type ReviewStore } from "./reviews";
import { STAFF_ROLES, TENANTS } from "./users";

// The chat UI talks to these routes. They follow the LangGraph server's thread API,
// so assistant-ui's LangGraph runtime can stream from them.

// Lesson 13: a doctor sends questions only. A paused draft is decided from the inbox, by a reviewer.
const runSchema = z.object({
  messages: z.array(z.object({ id: z.string(), type: z.literal("human"), content: z.string().min(1) })).min(1)
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "filed", "dismissed"]),
  note: z.string().max(500).optional()
});

// Lesson 14: an email to check, either a saved draft or pasted text for one country.
const factCheckSchema = z.union([
  z.object({ draftId: z.string().min(1) }),
  z.object({ text: z.string().min(1).max(4000), country: z.enum(["US", "DE", "JP"]) })
]);
const planSchema = z.object({ query: z.string().min(1).max(1000) });

// What the routes need besides sign-in: the agents, and where threads and review items live.
export type Desk = {
  agent: MedinfoAgent;
  // Lesson 14: two more agents on the same base.
  factChecker: FactChecker;
  outreachPlanner: OutreachPlanner;
  reviews: ReviewStore;
  recordDecision: (item: ReviewItem) => Promise<void>;
};

// Lesson 11. Sign-in, sign-out and the callback live in src/server/auth.ts. Everything here needs
// a signed-in user. A thread you did not start does not exist for you.
export function createRoutes(auth: Auth, desk: Desk) {
  const routes = Router();
  routes.use("/api", auth.requireUser);

  // Who is signed in, and the desk they ask: what the page shows in its header.
  routes.get("/api/me", (_request, response) => {
    const user = currentUser(response);
    const tenant = TENANTS[user.tenantId];
    response.json({ user, company: { name: tenant.name, medicines: tenant.medicines } });
  });

  routes.post("/api/threads", async (_request, response) => {
    const threadId = randomUUID();
    await desk.reviews.createThread(threadId, currentUser(response));
    response.json({ thread_id: threadId });
  });

  routes.get("/api/threads/:threadId/state", async (request, response) => {
    if (!(await desk.reviews.ownsThread(request.params.threadId, currentUser(response).userId))) {
      response.status(404).json({ error: "No such thread." });
      return;
    }
    response.json(await desk.agent.readThread(request.params.threadId));
  });

  routes.post("/api/threads/:threadId/runs/stream", async (request, response) => {
    const user = currentUser(response);
    if (!(await desk.reviews.ownsThread(request.params.threadId, user.userId))) {
      response.status(404).json({ error: "No such thread." });
      return;
    }
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Send at least one message." });
      return;
    }
    // A thread that waits for a reviewer takes no new question: a new turn would leave the
    // waiting draft behind, and its approval would then release whatever waits next.
    const { interrupts } = await desk.agent.readThread(request.params.threadId);
    if (interrupts.length) {
      response.status(409).json({ error: "This conversation waits for a reviewer. Start a new chat to ask something else." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await desk.agent.runTurn(
        { threadId: request.params.threadId, user, messages: parsed.data.messages, inbox: desk.reviews },
        ({ event, data }) => send(event, data)
      );
    } catch (error) {
      console.error(error);
      // The chat shows replies, not error events, so the doctor reads the reason as the assistant's reply.
      const content = isBudgetSpent(error) ? BUDGET_SPENT_MESSAGE : "The agent could not finish this answer. Please try again.";
      const { messages } = await desk.agent.readThread(request.params.threadId).catch(() => ({ messages: [] }));
      send("values", { messages: [...messages, { id: `error-${randomUUID()}`, type: "ai", content, tool_calls: [] }] });
    }
    response.end();
  });

  // Lesson 14. The editor and the rep board are for the company's staff, not the doctors who use
  // the desk. This answers the page with a clear 403; OpenFGA still decides which records they read.
  routes.use(["/api/drafts", "/api/fact-check", "/api/hcps", "/api/outreach"], (_request, response, next) => {
    if (currentUser(response).roles.some((role) => STAFF_ROLES.includes(role))) return next();
    response.status(403).json({ error: "This page is for your company's sales reps and medical reviewers." });
  });

  // The email editor: the company's own drafts, and a fact-check of one. Each check is its own
  // thread, owned by whoever asked, so a flagged email goes to someone else to approve.
  routes.get("/api/drafts", (_request, response) => {
    const user = currentUser(response);
    response.json({ drafts: CONTENT_DRAFTS.filter((draft) => draft.tenantId === user.tenantId) });
  });

  routes.post("/api/fact-check", async (request, response) => {
    const user = currentUser(response);
    const parsed = factCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Send a draft id, or the text and the country it goes to." });
      return;
    }
    const threadId = randomUUID();
    await desk.reviews.createThread(threadId, user);
    const request_ = "draftId" in parsed.data ? { draftId: parsed.data.draftId } : { text: scrubPhi(parsed.data.text).text, country: parsed.data.country };
    try {
      response.json(await desk.factChecker({ request: request_, user, inbox: desk.reviews, threadId }));
    } catch (error) {
      console.error(error);
      response.status(isBudgetSpent(error) ? 429 : 502).json({ error: isBudgetSpent(error) ? BUDGET_SPENT_MESSAGE : "The fact-check could not finish. Please try again." });
    }
  });

  // Lesson 14. The rep board: the doctors this company calls on, each as one shared profile.
  routes.get("/api/hcps", async (_request, response) => {
    const visible = await visibleHcps(currentUser(response));
    response.json({ hcps: PROFILES.filter((profile) => visible.has(profile.hcpId)).map(recordOf) });
  });

  routes.post("/api/outreach/plan", async (request, response) => {
    const user = currentUser(response);
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Say what you want to plan, with the doctor's CRM id." });
      return;
    }
    const threadId = randomUUID();
    await desk.reviews.createThread(threadId, user);
    try {
      response.json(await desk.outreachPlanner({ query: scrubPhi(parsed.data.query).text, user, inbox: desk.reviews, threadId }));
    } catch (error) {
      console.error(error);
      response.status(isBudgetSpent(error) ? 429 : 502).json({ error: isBudgetSpent(error) ? BUDGET_SPENT_MESSAGE : "The plan could not finish. Please try again." });
    }
  });

  // Lesson 13. A reviewer sees what waits for them; a doctor sees what became of their own items.
  routes.get("/api/inbox", async (_request, response) => {
    const user = currentUser(response);
    const reviewer = user.roles.length > 0;
    response.json({ reviewer, items: reviewer ? await desk.reviews.waitingFor(user) : await desk.reviews.raisedBy(user) });
  });

  // The approver is whoever is signed in. Nothing in the body can name someone else.
  routes.post("/api/inbox/:itemId/decision", async (request, response) => {
    const reviewer = currentUser(response);
    const parsed = decisionSchema.safeParse(request.body);
    const item = await desk.reviews.get(request.params.itemId);
    if (!item) {
      response.status(404).json({ error: "No such item." });
      return;
    }
    if (!(await desk.reviews.canDecide(reviewer, item))) {
      response.status(403).json({ error: "You cannot decide this item." });
      return;
    }
    if (!parsed.success || !DECISIONS[item.kind].includes(parsed.data.decision)) {
      response.status(400).json({ error: `Decide with one of: ${DECISIONS[item.kind].join(", ")}.` });
      return;
    }
    // The decision must be for the draft its thread waits on now, not one the thread has left.
    if (item.kind === "draft") {
      const { interrupts } = await desk.agent.readThread(item.threadId);
      if (!interrupts.some((pause) => (pause.value as { itemId?: string } | undefined)?.itemId === item.id)) {
        response.status(409).json({ error: "This draft no longer waits in its conversation." });
        return;
      }
    }
    const decided = await desk.reviews.decide(item.id, reviewer, parsed.data.decision, parsed.data.note ?? "");
    if (!decided) {
      response.status(409).json({ error: "Someone already decided this item." });
      return;
    }
    if (decided.kind === "draft") {
      try {
        // The paused thread picks up where it stopped, in this process or any other.
        await desk.agent.runTurn({ threadId: decided.threadId, user: reviewer, resume: { itemId: decided.id, decision: decided.status === "approved" ? "approve" : "reject" } }, () => {});
      } catch (error) {
        console.error(error);
        await desk.reviews.reopen(decided.id);
        response.status(502).json({ error: "The thread could not continue. The item is waiting again." });
        return;
      }
    }
    await desk.recordDecision(decided).catch((error) => console.error("The decision score was not written:", error));
    response.json(decided);
  });

  return routes;
}
