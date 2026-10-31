import { projectInputSchema } from "@/modules/projects/service";
import {
  apiRoute,
  created,
  dateField,
  idParam,
  paginate,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/projects - ?clientId= (one client's projects), ?search= (project
// or client name contains), paged.
// POST /api/v1/projects - create a project. dueDate is an ISO 8601 date.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const clientId = url.searchParams.get("clientId");
  const projects = await caller.projects.list({
    clientId: clientId === null ? undefined : idParam(clientId, "client"),
    search: url.searchParams.get("search") ?? undefined,
  });
  return paginate(projects, url);
});

export const POST = apiRoute(async (req, { caller }) => {
  const body = await readBody(req);
  dateField(body, "dueDate");
  return created(await caller.projects.create(projectInputSchema.parse(body)));
});
