import { projectInputSchema } from "@/modules/projects/service";
import {
  apiRoute,
  dateField,
  idParam,
  mergeInput,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/projects/:projectId - one project.
// PATCH /api/v1/projects/:projectId - change the fields sent; the rest keep
// their values. dueDate: null clears it.
export const dynamic = "force-dynamic";

type Params = { projectId: string };

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.projects.get({ projectId: idParam(params.projectId, "project") }),
);

export const PATCH = apiRoute<Params>(async (req, { caller, params }) => {
  const projectId = idParam(params.projectId, "project");
  const patch = await readBody(req);
  dateField(patch, "dueDate");
  const current = await caller.projects.get({ projectId });
  const data = projectInputSchema.parse(
    mergeInput(projectInputSchema, current, patch),
  );
  return caller.projects.update({ projectId, data });
});
