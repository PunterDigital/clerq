import { clientInputSchema } from "@/modules/clients/service";
import { apiRoute, idParam, mergeInput, readBody } from "@/server/api/v1";

// GET /api/v1/clients/:clientId - one client.
// PATCH /api/v1/clients/:clientId - change the fields sent; the rest keep
// their values (contacts is replaced as a whole list).
export const dynamic = "force-dynamic";

type Params = { clientId: string };

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.clients.get({ clientId: idParam(params.clientId, "client") }),
);

export const PATCH = apiRoute<Params>(async (req, { caller, params }) => {
  const clientId = idParam(params.clientId, "client");
  const patch = await readBody(req);
  const current = await caller.clients.get({ clientId });
  const data = clientInputSchema.parse(
    mergeInput(clientInputSchema, current, patch),
  );
  return caller.clients.update({ clientId, data });
});
