import { clientInputSchema } from "@/modules/clients/service";
import {
  apiRoute,
  boolParam,
  created,
  paginate,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/clients - ?search= (name contains), ?includeArchived=true, paged.
// POST /api/v1/clients - create a client.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const clients = await caller.clients.list({
    search: url.searchParams.get("search") ?? undefined,
    includeArchived: boolParam(url, "includeArchived"),
  });
  return paginate(clients, url);
});

export const POST = apiRoute(async (req, { caller }) => {
  const input = clientInputSchema.parse(await readBody(req));
  return created(await caller.clients.create(input));
});
