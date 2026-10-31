import { currentVersion } from "@/lib/version";
import { buildOpenApiDocument, publicOrigin } from "@/server/api/openapi";

// GET /api/v1/openapi.json - the OpenAPI 3.1 document for this API, built from
// the endpoints' own Zod schemas (server/api/openapi.ts). Public: it describes
// the API and serves no data, so tools can read it without a key.
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return Response.json(
    buildOpenApiDocument(publicOrigin(req.headers), currentVersion() ?? "dev"),
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}
