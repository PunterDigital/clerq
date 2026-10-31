import { manualEntrySchema } from "@/modules/time/service";
import { publicEntry } from "@/server/api/time";
import {
  ApiError,
  apiRoute,
  created,
  dateField,
  dateParam,
  idParam,
  paginate,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/time-entries - ?taskId= (everyone's entries on a task, newest
// first; needs permission to view all time) and/or ?from=&to= (ISO dates,
// [from, to)). With only a date range it lists the key creator's own
// finished entries, oldest first, with task, project and client names. Paged.
// POST /api/v1/time-entries - log a manual entry as the key's creator.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, ctx) => {
  const { caller, url } = ctx;
  const taskId = url.searchParams.get("taskId");
  const from = dateParam(url, "from");
  const to = dateParam(url, "to");
  if ((from === null) !== (to === null)) {
    throw new ApiError(422, "Pass both from and to, or neither");
  }
  if (from && to && from >= to) {
    throw new ApiError(422, "from must be before to");
  }

  if (taskId !== null) {
    const entries = await caller.time.listForTask({ taskId: idParam(taskId, "task") });
    const inRange =
      from && to
        ? entries.filter((e) => e.startedAt >= from && e.startedAt < to)
        : entries;
    return paginate(
      inRange.map((entry) => publicEntry(entry, ctx)),
      url,
    );
  }
  if (from && to) {
    return paginate(await caller.time.listMine({ from, to }), url);
  }
  throw new ApiError(422, "Pass taskId, or from and to");
});

export const POST = apiRoute(async (req, ctx) => {
  const body = await readBody(req);
  dateField(body, "startedAt");
  const entry = await ctx.caller.time.logManual(manualEntrySchema.parse(body));
  return created(publicEntry(entry, ctx));
});
