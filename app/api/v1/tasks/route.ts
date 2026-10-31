import {
  taskInputSchema,
  taskStatusSchema,
} from "@/modules/projects/tasks-service";
import {
  ApiError,
  apiRoute,
  created,
  idParam,
  paginate,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/tasks - ?projectId= (a project's tasks, oldest first, with
// trackedSeconds) or ?search= (title contains, across the business, newest
// first, with project and client names). Either can add ?status=. Paged.
// POST /api/v1/tasks - create a task: { "projectId", "title", "status"?,
// "estimateMinutes"? }.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const projectId = url.searchParams.get("projectId");
  const search = url.searchParams.get("search");
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === null ? null : taskStatusSchema.safeParse(statusParam);
  if (status && !status.success) {
    throw new ApiError(
      422,
      `status must be one of: ${taskStatusSchema.options.join(", ")}`,
    );
  }

  let tasks: { status: string }[];
  if (projectId !== null) {
    tasks = await caller.tasks.list({ projectId: idParam(projectId, "project") });
  } else if (search !== null && search.trim()) {
    tasks = await caller.tasks.search({ search });
  } else {
    throw new ApiError(422, "Pass projectId or search");
  }
  return paginate(
    status ? tasks.filter((task) => task.status === status.data) : tasks,
    url,
  );
});

export const POST = apiRoute(async (req, { caller }) => {
  const { projectId, ...rest } = await readBody(req);
  if (typeof projectId !== "string") {
    throw new ApiError(422, "projectId is required");
  }
  return created(
    await caller.tasks.create({
      projectId: idParam(projectId, "project"),
      data: taskInputSchema.parse(rest),
    }),
  );
});
