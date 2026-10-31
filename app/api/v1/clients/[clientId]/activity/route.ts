import { apiRoute, idParam, paginate } from "@/server/api/v1";

// GET /api/v1/clients/:clientId/activity - the client's activity thread
// (notes, edits, invoices), newest first, paged.
export const dynamic = "force-dynamic";

export const GET = apiRoute<{ clientId: string }>(async (_req, { caller, params, url }) =>
  paginate(
    await caller.clients.activity({ clientId: idParam(params.clientId, "client") }),
    url,
  ),
);
