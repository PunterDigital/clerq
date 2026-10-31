import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  notExists,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";
import { likeContains } from "@/lib/search";

// Tasks live inside the projects module (the repo map: projects owns
// projects + tasks). Same tenancy contract: businessId on every query,
// and a task can only ever attach to a project of the same business.

export const taskStatusSchema = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "done",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  status: taskStatusSchema.default("todo"),
  estimateMinutes: z.number().int().positive().max(60 * 1000).nullable().optional(),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

async function projectInBusiness(
  db: Db,
  businessId: string,
  projectId: string,
) {
  const [row] = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(
      and(
        eq(schema.project.businessId, businessId),
        eq(schema.project.id, projectId),
      ),
    );
  return Boolean(row);
}

export async function listTasks(db: Db, businessId: string, projectId: string) {
  // trackedSeconds sums the task's closed entries (running timers join in
  // once stopped); pg returns the aggregate as a string, hence Number().
  const rows = await db
    .select({
      ...getTableColumns(schema.task),
      trackedSeconds: sql<string>`coalesce(sum(${schema.timeEntry.durationSeconds}), 0)`,
    })
    .from(schema.task)
    .leftJoin(
      schema.timeEntry,
      and(
        eq(schema.timeEntry.taskId, schema.task.id),
        isNotNull(schema.timeEntry.endedAt),
      ),
    )
    .where(
      and(
        eq(schema.task.businessId, businessId),
        eq(schema.task.projectId, projectId),
      ),
    )
    .groupBy(schema.task.id)
    .orderBy(asc(schema.task.createdAt));
  return rows.map((row) => ({
    ...row,
    trackedSeconds: Number(row.trackedSeconds),
  }));
}

export async function getTask(db: Db, businessId: string, taskId: string) {
  const [row] = await db
    .select()
    .from(schema.task)
    .where(
      and(eq(schema.task.businessId, businessId), eq(schema.task.id, taskId)),
    );
  return row ?? null;
}

// Business-wide task search by title, used by the projects page so a search
// there surfaces matching tasks alongside matching projects. Carries the
// parent project and client names so a result links back and reads in
// context. Returns [] for an empty term rather than every task.
export async function searchTasks(
  db: Db,
  businessId: string,
  search: string,
) {
  const term = search.trim();
  if (!term) {
    return [];
  }
  return db
    .select({
      id: schema.task.id,
      title: schema.task.title,
      status: schema.task.status,
      projectId: schema.task.projectId,
      projectName: schema.project.name,
      clientName: schema.client.name,
    })
    .from(schema.task)
    .innerJoin(schema.project, eq(schema.task.projectId, schema.project.id))
    .innerJoin(schema.client, eq(schema.project.clientId, schema.client.id))
    .where(
      and(
        eq(schema.task.businessId, businessId),
        ilike(schema.task.title, likeContains(term)),
      ),
    )
    .orderBy(desc(schema.task.createdAt));
}

export async function createTask(
  db: Db,
  businessId: string,
  projectId: string,
  input: TaskInput,
) {
  if (!(await projectInBusiness(db, businessId, projectId))) {
    return null;
  }
  const [created] = await db
    .insert(schema.task)
    .values({
      businessId,
      projectId,
      title: input.title,
      status: input.status,
      estimateMinutes: input.estimateMinutes ?? null,
    })
    .returning();
  return created;
}

export async function updateTask(
  db: Db,
  businessId: string,
  taskId: string,
  input: TaskInput,
) {
  const [updated] = await db
    .update(schema.task)
    .set({
      title: input.title,
      status: input.status,
      estimateMinutes: input.estimateMinutes ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(schema.task.businessId, businessId), eq(schema.task.id, taskId)),
    )
    .returning();
  return updated ?? null;
}

export async function setTaskStatus(
  db: Db,
  businessId: string,
  taskId: string,
  status: TaskStatus,
) {
  const [updated] = await db
    .update(schema.task)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(schema.task.businessId, businessId), eq(schema.task.id, taskId)),
    )
    .returning();
  return updated ?? null;
}

// Deleting a task cascades to its time entries, which permanently discards
// tracked time. Time that is billed on an invoice line must never vanish
// that way (an issued invoice would silently lose its backing record, and a
// voided-then-stuck line its audit trail), so the delete refuses while any
// of the task's entries are linked to a line. The guard lives in the DELETE
// itself (NOT EXISTS) so a concurrent generation cannot slip billed time in
// between a check and the delete. Callers release the time first: remove
// the draft's lines, delete the draft, or void the issued invoice.
export type DeleteTaskResult =
  | { ok: true; task: typeof schema.task.$inferSelect }
  | { ok: false; reason: "not_found" | "billed_time" };

export async function deleteTask(
  db: Db,
  businessId: string,
  taskId: string,
): Promise<DeleteTaskResult> {
  const [deleted] = await db
    .delete(schema.task)
    .where(
      and(
        eq(schema.task.businessId, businessId),
        eq(schema.task.id, taskId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(schema.timeEntry)
            .where(
              and(
                eq(schema.timeEntry.taskId, schema.task.id),
                isNotNull(schema.timeEntry.invoiceLineId),
              ),
            ),
        ),
      ),
    )
    .returning();
  if (deleted) {
    return { ok: true, task: deleted };
  }
  const [existing] = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(
      and(eq(schema.task.businessId, businessId), eq(schema.task.id, taskId)),
    );
  return { ok: false, reason: existing ? "billed_time" : "not_found" };
}
