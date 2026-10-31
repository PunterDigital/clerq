import { apiRoute, idParam } from "@/server/api/v1";

// POST /api/v1/clients/:clientId/unarchive - bring an archived client back.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ clientId: string }>(async (_req, { caller, params }) =>
  caller.clients.unarchive({ clientId: idParam(params.clientId, "client") }),
);
