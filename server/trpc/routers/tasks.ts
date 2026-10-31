import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  searchTasks,
  setTaskStatus,
  taskInputSchema,
  taskStatusSchema,
  updateTask,
} from "@/modules/projects/tasks-service";

import { createTRPCRouter, permissionProcedure } from "../init";

function found<T>(row: T | null): T {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
  }
  return row;
}

export const tasksRouter = createTRPCRouter({
  list: permissionProcedure("tasks.view")
    .input(z.object({ projectId: z.string().uuid() }))
    .query(({ ctx, input }) => listTasks(getDb(), ctx.businessId, input.projectId)),

  get: permissionProcedure("tasks.view")
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      found(await getTask(getDb(), ctx.businessId, input.taskId)),
    ),

  // Business-wide task search, used by the projects page alongside the
  // project search. Returns [] for an empty term.
  search: permissionProcedure("tasks.view")
    .input(z.object({ search: z.string() }))
    .query(({ ctx, input }) =>
      searchTasks(getDb(), ctx.businessId, input.search),
    ),

  create: permissionProcedure("tasks.create")
    .input(z.object({ projectId: z.string().uuid(), data: taskInputSchema }))
    .mutation(async ({ ctx, input }) =>
      found(await createTask(getDb(), ctx.businessId, input.projectId, input.data)),
    ),

  update: permissionProcedure("tasks.edit")
    .input(z.object({ taskId: z.string().uuid(), data: taskInputSchema }))
    .mutation(async ({ ctx, input }) =>
      found(await updateTask(getDb(), ctx.businessId, input.taskId, input.data)),
    ),

  setStatus: permissionProcedure("tasks.edit")
    .input(z.object({ taskId: z.string().uuid(), status: taskStatusSchema }))
    .mutation(async ({ ctx, input }) =>
      found(
        await setTaskStatus(getDb(), ctx.businessId, input.taskId, input.status),
      ),
    ),

  delete: permissionProcedure("tasks.delete")
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await deleteTask(getDb(), ctx.businessId, input.taskId);
      if (!result.ok) {
        if (result.reason === "billed_time") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This task has time billed on an invoice. Remove those invoice lines, delete the draft, or void the issued invoice to release the time, then delete the task.",
          });
        }
        throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      }
      return result.task;
    }),
});
