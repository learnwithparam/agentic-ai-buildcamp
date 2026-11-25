import { AGENT_CARD_PATH, AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, type AgentExecutor, type TaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { AuthError, type Auth } from "../auth";
import type { Identity } from "../users";
import { A2A_AGENTS, a2aPath, agentCard, type A2aAgentName } from "./cards";
import { TokenUser } from "./tasks";

// Lesson 15. Each agent as an A2A server: its card at a well-known path, and JSON-RPC for work.
//   - The card is public: it is how a caller learns what the agent does and how to sign in.
//   - Work needs a Keycloak access token for the person asking, the same token the app checks
//     (lesson 11). Cookies are never accepted here, the rule lesson 12 set for MCP.
//   - The caller's trace context (the W3C traceparent header) is joined, so the work shows in
//     the caller's Langfuse trace, and a whole hand-off is one session.

const verified = new WeakMap<Request, Identity>();

export function createA2aRouter(auth: Auth, options: { store: TaskStore; executors: Record<A2aAgentName, AgentExecutor>; appUrl?: string }) {
  const router = Router();
  const appUrl = options.appUrl ?? auth.appUrl;
  const appOrigin = new URL(auth.appUrl).origin;

  // A page on another site sends its own Origin. An agent calling from a server sends none.
  function noOtherSite(request: Request, response: Response, next: NextFunction) {
    const origin = request.headers.origin;
    if (origin && origin !== appOrigin) {
      response.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Requests from other sites are refused." }, id: null });
      return;
    }
    next();
  }

  async function requireToken(request: Request, response: Response, next: NextFunction) {
    const header = request.headers.authorization;
    const refuse = () =>
      response
        .status(401)
        .set("WWW-Authenticate", `Bearer realm="${auth.issuer}"`)
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "Send a Keycloak access token as a Bearer token. The agent card names where to get one." }, id: null });
    if (!header?.startsWith("Bearer ")) return refuse();
    try {
      verified.set(request, await auth.verifyToken(header.slice("Bearer ".length)));
    } catch (error) {
      if (error instanceof AuthError) return refuse();
      return next(error);
    }
    next();
  }

  // The tenant is the company in the token. A request that names an A2A tenant of its own is
  // refused, so no part of the request decides whose data it reaches.
  function noRequestTenant(request: Request, response: Response, next: NextFunction) {
    const tenant = (request.body as { params?: { tenant?: unknown } } | undefined)?.params?.tenant;
    if (tenant) {
      response.status(400).json({ jsonrpc: "2.0", error: { code: -32602, message: "This agent takes no tenant in the request; it is read from your token." }, id: null });
      return;
    }
    next();
  }

  function joinTrace(request: Request, _response: Response, next: NextFunction) {
    context.with(propagation.extract(ROOT_CONTEXT, request.headers), next);
  }

  for (const name of A2A_AGENTS) {
    const card = agentCard(name, appUrl, auth.issuer);
    const handler = new DefaultRequestHandler(card, options.store, options.executors[name]);
    const base = a2aPath(name);
    router.use(base, noOtherSite);
    // The card in the A2A JSON form (AgentCard.toJSON). The SDK keeps cards in its own shape, which
    // a client built from the spec reads with no sign-in scheme at all, so the card is converted here.
    const published = AgentCard.toJSON(card);
    router.get(`${base}/${AGENT_CARD_PATH}`, (_request, response) => {
      response.json(published);
    });
    // The SDK's JSON-RPC handler is a router too, so it sits under the agent's path, after the checks.
    const work = Router();
    work.post(
      "/",
      requireToken,
      express.json({ limit: "1mb" }),
      noRequestTenant,
      joinTrace,
      jsonRpcHandler({ requestHandler: handler, userBuilder: async (request) => new TokenUser(verified.get(request)!) })
    );
    router.use(base, work);
  }
  return router;
}
