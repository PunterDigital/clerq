import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { publicErrorMessage } from "@/server/trpc/errors";
import { createTRPCContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/routers/_app";

// CSRF (#5584): the session cookie is SameSite=Lax, and the PR previews
// (*.preview.useclerq.net) count as the same site. tRPC 11 also accepts
// multipart/form-data, which a plain HTML form on such a site can POST with
// the cookie attached. Our client always sends JSON, and a cross-site JSON
// POST needs a CORS preflight we never answer, so anything else is refused
// before it reaches a procedure.
function isJson(req: Request): boolean {
  const type = req.headers.get("content-type") ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/json";
}

const handler = (req: Request) => {
  if (req.method === "POST" && !isJson(req)) {
    return new Response(
      JSON.stringify({ error: { message: "Send tRPC requests as application/json" } }),
      { status: 415, headers: { "Content-Type": "application/json" } },
    );
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
    onError({ error, path }) {
      // The client only sees a generic message for internal errors (see
      // server/trpc/errors.ts), so keep the real one in the server log.
      if (publicErrorMessage(error) !== error.message) {
        console.error(`tRPC ${path ?? "?"} failed:`, error.cause ?? error);
      }
    },
  });
};

export { handler as GET, handler as POST };
