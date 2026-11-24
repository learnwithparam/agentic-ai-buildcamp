import { observe, propagateAttributes } from "@langfuse/tracing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { decodeJwt } from "jose";
import { z } from "zod";
import { AuthError, type Auth } from "./auth";
import { executeTool } from "./tools";
import type { Identity } from "./users";

// Lesson 12. The same two tools the chat agent uses, behind the Model Context Protocol, so Claude
// Code or another agent can look up a label. Every call carries a Keycloak access token, and the
// tools answer for the user in that token, exactly as they do in the chat (lesson 11):
//   - Bearer tokens only. A browser cookie is never accepted here, so no other site's page can
//     call these tools as a signed-in doctor.
//   - With no token, the 401 names this server's protected-resource metadata (RFC 9728), which
//     names Keycloak. That is how an MCP client finds where to sign in.
//   - Stateless: each POST is one JSON-RPC exchange with a fresh server, so nothing of one user's
//     call can be left behind for the next.

export const MCP_PATH = "/api/mcp";
export const METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
// The routes an MCP client may call before it has a token.
export const MCP_PUBLIC_ROUTES = [`GET ${METADATA_PATH}`];

type Verified = { identity: Identity };

function mcpServerFor(user: Identity) {
  const server = new McpServer({ name: "medinfo", version: "1.0.0" });
  const run = (name: string, input: Record<string, unknown>) =>
    traced(name, input, user).then((result) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }] }));

  server.registerTool(
    "get_desk_rules",
    {
      title: "Desk rules",
      description: "Today's date, the company and medicines this desk covers, the asker's country, and how to cite.",
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => run("get_desk_rules", {})
  );
  server.registerTool(
    "search_labels",
    {
      title: "Search the label library",
      description:
        "Search prescribing information, trial summaries, the FAQ and the safety procedure. Returns only documents the signed-in doctor may read, for their company and country.",
      inputSchema: { query: z.string().min(1).max(500).describe("What to look up, with the medicine and country when known.") },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    ({ query }) => run("search_labels", { query })
  );
  return server;
}

// Each tool call is its own Langfuse trace, tagged mcp, with the user id, company and country
// (never the name or email, the same rule as src/server/trace-identity.test.ts).
const traced = observe(
  (name: string, input: Record<string, unknown>, user: Identity) =>
    propagateAttributes(
      {
        userId: user.userId,
        metadata: { tenantId: user.tenantId, country: user.country },
        traceName: `mcp-${name}`,
        tags: ["hcp-medinfo", "mcp"]
      },
      () => executeTool(name, input, user)
    ),
  { name: "mcp-tool-call", asType: "span", captureInput: false }
);

export function createMcpRouter(auth: Auth) {
  const router = Router();
  const resource = new URL(MCP_PATH, auth.appUrl).href;
  const metadataUrl = new URL(METADATA_PATH, auth.appUrl).href;

  router.get(METADATA_PATH, (_request, response) => {
    response.json({
      resource,
      authorization_servers: [auth.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email", "organization"],
      resource_name: "HCP Medical Information"
    });
  });

  const requireToken = requireBearerAuth({
    resourceMetadataUrl: metadataUrl,
    verifier: {
      async verifyAccessToken(token) {
        let identity: Identity;
        try {
          identity = await auth.verifyToken(token);
        } catch (error) {
          if (error instanceof AuthError) throw new InvalidTokenError("The token is missing, expired or not for this server.");
          throw error;
        }
        // The signature, issuer, audience and expiry were checked above; this only reads them.
        const claims = decodeJwt(token);
        return {
          token,
          clientId: String(claims.azp ?? ""),
          scopes: String(claims.scope ?? "").split(" ").filter(Boolean),
          expiresAt: claims.exp,
          extra: { identity } satisfies Verified
        };
      }
    }
  });

  // A browser page on another site sends its own Origin. MCP clients such as Claude Code send none.
  const appOrigin = new URL(auth.appUrl).origin;
  function noOtherSite(request: Request, response: Response, next: NextFunction) {
    const origin = request.headers.origin;
    if (origin && origin !== appOrigin) {
      response.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Requests from other sites are refused." }, id: null });
      return;
    }
    next();
  }
  router.use(MCP_PATH, noOtherSite);

  router.post(MCP_PATH, requireToken, express.json({ limit: "1mb" }), async (request: Request, response: Response) => {
    const { identity } = request.auth!.extra as Verified;
    const server = mcpServerFor(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  // Stateless: there is no stream to open with GET and no session to end with DELETE.
  for (const method of ["get", "delete"] as const) {
    router[method](MCP_PATH, requireToken, (_request, response) => {
      response.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    });
  }
  return router;
}
