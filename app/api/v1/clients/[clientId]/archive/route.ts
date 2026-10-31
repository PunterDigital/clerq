import { apiRoute, idParam } from "@/server/api/v1";

// POST /api/v1/clients/:clientId/archive - archive a client.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ clientId: string }>(async (_req, { caller, params }) =>
  caller.clients.archive({ clientId: idParam(params.clientId, "client") }),
);
