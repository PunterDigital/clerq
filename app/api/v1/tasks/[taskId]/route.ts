import { taskInputSchema } from "@/modules/projects/tasks-service";
import { apiRoute, idParam, mergeInput, readBody } from "@/server/api/v1";

// GET /api/v1/tasks/:taskId - one task.
// PATCH /api/v1/tasks/:taskId - change the title, status or estimate; fields
// left out keep their values.
// DELETE /api/v1/tasks/:taskId - delete the task and its time entries. 409
// while any of its time is billed on an invoice.
export const dynamic = "force-dynamic";

type Params = { taskId: string };

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.tasks.get({ taskId: idParam(params.taskId, "task") }),
);

export const PATCH = apiRoute<Params>(async (req, { caller, params }) => {
  const taskId = idParam(params.taskId, "task");
  const patch = await readBody(req);
  const current = await caller.tasks.get({ taskId });
  const data = taskInputSchema.parse(mergeInput(taskInputSchema, current, patch));
  return caller.tasks.update({ taskId, data });
});

export const DELETE = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.tasks.delete({ taskId: idParam(params.taskId, "task") }),
);
