import { publicEntry } from "@/server/api/time";
import { apiRoute } from "@/server/api/v1";

// POST /api/v1/timer/stop - stop the running timer. Returns the finished
// entry: { "entry": {...} }, or { "entry": null } when nothing was running.
export const dynamic = "force-dynamic";

export const POST = apiRoute(async (_req, ctx) => {
  const entry = await ctx.caller.time.stop();
  return { entry: entry ? publicEntry(entry, ctx) : null };
});
