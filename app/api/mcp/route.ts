import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withMcpAuth } from "better-auth/plugins";

import { getDb } from "@/db";
import { bearerToken, looksLikeApiKey, verifyApiKey } from "@/server/api-keys";
import { getAuth } from "@/server/auth";
import {
  createClerqCaller,
  mcpContextForUser,
  type ClerqCaller,
} from "@/server/mcp/caller";
import { createClerqMcpServer } from "@/server/mcp/server";
import { getActiveMembership, getMembershipIn } from "@/server/membership";

// The MCP protected resource. withMcpAuth validates the OAuth bearer token
// (via the Better Auth `mcp` plugin) and rejects unauthenticated requests
// with a 401 that points clients at the protected-resource metadata, kicking
// off the OAuth flow. Authenticated requests are dispatched to a per-request
// MCP server bound to a tRPC caller scoped to the user's active business.
//
// getAuth() is resolved per request (never at module load) so the build and
// Docker builder stage never instantiate the DB-backed auth instance.
async function handle(req: Request): Promise<Response> {
  // A Clerq API key (Settings -> API keys) is accepted next to the OAuth
  // tokens: it never expires, so a server-to-server integration can use one
  // from its environment. The key pins its own business and scope.
  const token = bearerToken(req.headers);
  if (token && looksLikeApiKey(token)) {
    const key = await verifyApiKey(getDb(), token);
    if (!key) {
      return Response.json(
        { error: "invalid_key", message: "This API key is not valid or has been revoked." },
        { status: 401 },
      );
    }
    const membership = await getMembershipIn(key.userId, key.businessId);
    if (!membership) {
      return Response.json(
        {
          error: "invalid_key",
          message: "The person who created this API key is no longer in the business.",
        },
        { status: 401 },
      );
    }
    return serve(
      req,
      createClerqCaller(
        mcpContextForUser(key.userId, req.headers, {
          id: key.id,
          businessId: key.businessId,
          scope: key.scope,
        }),
      ),
      key.businessId,
    );
  }

  const auth = getAuth();
  return withMcpAuth(auth, async (request, session) => {
    const membership = await getActiveMembership(session.userId);
    if (!membership) {
      // Authenticated but the user has no business yet: a clear 403 rather
      // than an opaque tool failure.
      return Response.json(
        { error: "no_business", message: "Create a business first." },
        { status: 403 },
      );
    }

    return serve(
      request,
      createClerqCaller(mcpContextForUser(session.userId, request.headers)),
      membership.businessId,
    );
  })(req);
}

async function serve(
  request: Request,
  caller: ClerqCaller,
  businessId: string,
): Promise<Response> {
  const server = createClerqMcpServer({
    caller,
    businessId,
    baseUrl: new URL(request.url).origin,
  });

  // Stateless: a fresh server + transport per request, JSON responses (no
  // long-lived SSE session to track across the serverless boundary).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
