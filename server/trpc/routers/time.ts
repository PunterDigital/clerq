import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import {
  deleteEntry,
  getRunningTimer,
  listEntriesBetween,
  listEntriesForTask,
  logManualEntry,
  manualEntrySchema,
  startTimer,
  stopTimer,
  updateEntryNote,
} from "@/modules/time/service";
import { hideInternalCost, hideInternalCostOrNull } from "@/modules/time/visibility";

import { createTRPCRouter, permissionProcedure } from "../init";

function found<T>(row: T | null): T {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such entry" });
  }
  return row;
}

export const timeRouter = createTRPCRouter({
  running: permissionProcedure("time.viewOwn").query(({ ctx }) =>
    getRunningTimer(getDb(), ctx.businessId, ctx.session.user.id),
  ),

  start: permissionProcedure("time.log")
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      hideInternalCost(
        found(
          await startTimer(getDb(), ctx.businessId, ctx.session.user.id, input.taskId),
        ),
        ctx.permissions,
      ),
    ),

  // Stopping when nothing runs is a no-op, not an error - the timer may
  // have been stopped from another tab.
  stop: permissionProcedure("time.log").mutation(async ({ ctx }) =>
    hideInternalCostOrNull(
      await stopTimer(getDb(), ctx.businessId, ctx.session.user.id),
      ctx.permissions,
    ),
  ),

  logManual: permissionProcedure("time.log")
    .input(manualEntrySchema)
    .mutation(async ({ ctx, input }) =>
      hideInternalCost(
        found(
          await logManualEntry(getDb(), ctx.businessId, ctx.session.user.id, input),
        ),
        ctx.permissions,
      ),
    ),

  // Entries for a task span the whole team, so this needs the view-all grant.
  // Their internal cost only goes to callers who may view profit (#5583).
  listForTask: permissionProcedure("time.viewAll")
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      (await listEntriesForTask(getDb(), ctx.businessId, input.taskId)).map(
        (entry) => hideInternalCost(entry, ctx.permissions),
      ),
    ),

  // The caller's own timesheet window. [from, to) in UTC.
  listMine: permissionProcedure("time.viewOwn")
    .input(z.object({ from: z.date(), to: z.date() }))
    .query(({ ctx, input }) =>
      listEntriesBetween(
        getDb(),
        ctx.businessId,
        ctx.session.user.id,
        input.from,
        input.to,
      ),
    ),

  updateNote: permissionProcedure("time.edit")
    .input(
      z.object({
        entryId: z.string().uuid(),
        note: z.string().trim().max(10_000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      hideInternalCost(
        found(
          await updateEntryNote(getDb(), ctx.businessId, input.entryId, input.note),
        ),
        ctx.permissions,
      ),
    ),

  deleteEntry: permissionProcedure("time.delete")
    .input(z.object({ entryId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      hideInternalCost(
        found(await deleteEntry(getDb(), ctx.businessId, input.entryId)),
        ctx.permissions,
      ),
    ),
});
