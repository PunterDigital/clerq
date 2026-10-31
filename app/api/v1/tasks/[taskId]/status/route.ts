import { taskStatusSchema } from "@/modules/projects/tasks-service";
import { apiRoute, idParam, readBody } from "@/server/api/v1";

// POST /api/v1/tasks/:taskId/status - set only the status:
// { "status": "todo" | "in_progress" | "in_review" | "done" }.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ taskId: string }>(async (req, { caller, params }) => {
  const taskId = idParam(params.taskId, "task");
  const { status } = await readBody(req);
  return caller.tasks.setStatus({ taskId, status: taskStatusSchema.parse(status) });
});
