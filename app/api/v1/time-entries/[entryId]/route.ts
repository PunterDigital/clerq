import { timeEntryNoteBodySchema } from "@/server/api/schemas";
import { publicEntry } from "@/server/api/time";
import { apiRoute, idParam, readBody } from "@/server/api/v1";

// PATCH /api/v1/time-entries/:entryId - change the note: { "note": "..." },
// or null to clear it. The time itself can't be edited.
// DELETE /api/v1/time-entries/:entryId - delete an entry.
export const dynamic = "force-dynamic";

type Params = { entryId: string };

export const PATCH = apiRoute<Params>(async (req, ctx) => {
  const entryId = idParam(ctx.params.entryId, "entry");
  const { note } = timeEntryNoteBodySchema.parse(await readBody(req));
  return publicEntry(await ctx.caller.time.updateNote({ entryId, note }), ctx);
});

export const DELETE = apiRoute<Params>(async (_req, ctx) =>
  publicEntry(
    await ctx.caller.time.deleteEntry({
      entryId: idParam(ctx.params.entryId, "entry"),
    }),
    ctx,
  ),
);
