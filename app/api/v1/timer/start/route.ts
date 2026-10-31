import { timerStartBodySchema } from "@/server/api/schemas";
import { publicEntry } from "@/server/api/time";
import { apiRoute, created, readBody } from "@/server/api/v1";

// POST /api/v1/timer/start - start a timer on a task: { "taskId": "..." }.
// A timer that is already running is stopped (and saved) first.
export const dynamic = "force-dynamic";

export const POST = apiRoute(async (req, ctx) => {
  const { taskId } = timerStartBodySchema.parse(await readBody(req));
  return created(publicEntry(await ctx.caller.time.start({ taskId }), ctx));
});
