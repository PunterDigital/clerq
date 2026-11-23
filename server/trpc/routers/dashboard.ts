import { and, count, eq, inArray, isNotNull, isNull, ne, sql, sum } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { listInvoices, refreshOverdue } from "@/modules/billing/lifecycle";
import { listRecentActivity } from "@/modules/clients/service";
import { listEntriesBetween } from "@/modules/time/service";
import { addDays, startOfWeek } from "@/lib/week";

import { createTRPCRouter, permissionProcedure } from "../init";

export const dashboardRouter = createTRPCRouter({
  // One round trip for the whole dashboard. Aggregation only - every
  // number is composed from module services or scoped queries. Overdue
  // statuses are refreshed first; the reads after it are independent, so
  // they run in parallel, and the database does the counting and summing
  // instead of shipping every invoice, project and task id (#5695).
  summary: permissionProcedure("dashboard.view").query(async ({ ctx }) => {
    const db = getDb();
    const now = new Date();
    const weekStart = startOfWeek(now);
    const businessId = ctx.businessId;

    await refreshOverdue(db, businessId, now);

    const [
      outstandingRows,
      recentInvoices,
      weekEntries,
      [projectCount],
      [openTaskCount],
      [unbilled],
      recentActivity,
    ] = await Promise.all([
      db
        .select({
          currency: schema.invoice.currency,
          // Credit notes (#5042) reduce what the client owes.
          totalMinor: sql<string>`sum(${schema.invoice.totalMinor} - ${schema.invoice.creditedMinor})`,
          count: count(),
          overdue: sql<string>`count(*) filter (where ${schema.invoice.status} = 'overdue')`,
        })
        .from(schema.invoice)
        .where(
          and(
            eq(schema.invoice.businessId, businessId),
            inArray(schema.invoice.status, ["sent", "overdue"]),
          ),
        )
        .groupBy(schema.invoice.currency)
        // Newest outstanding invoice first, the order the totals had before.
        .orderBy(sql`max(${schema.invoice.createdAt}) desc`),
      listInvoices(db, businessId, now, { limit: 5, skipOverdueRefresh: true }),
      listEntriesBetween(db, businessId, ctx.session.user.id, weekStart, addDays(weekStart, 7)),
      db
        .select({ value: count() })
        .from(schema.project)
        .where(
          and(eq(schema.project.businessId, businessId), eq(schema.project.status, "active")),
        ),
      db
        .select({ value: count() })
        .from(schema.task)
        .where(and(eq(schema.task.businessId, businessId), ne(schema.task.status, "done"))),
      db
        .select({ seconds: sum(schema.timeEntry.durationSeconds) })
        .from(schema.timeEntry)
        .where(
          and(
            eq(schema.timeEntry.businessId, businessId),
            eq(schema.timeEntry.billable, true),
            isNotNull(schema.timeEntry.endedAt),
            isNull(schema.timeEntry.invoiceLineId),
          ),
        ),
      listRecentActivity(db, businessId, 6),
    ]);

    const weekSeconds = weekEntries.reduce(
      (total, entry) => total + (entry.durationSeconds ?? 0),
      0,
    );
    const weekProjects = new Set(weekEntries.map((entry) => entry.projectId)).size;

    return {
      outstanding: {
        totals: outstandingRows.map((row) => ({
          currency: row.currency,
          totalMinor: Number(row.totalMinor),
        })),
        count: outstandingRows.reduce((total, row) => total + row.count, 0),
        overdueCount: outstandingRows.reduce((total, row) => total + Number(row.overdue), 0),
      },
      week: { seconds: weekSeconds, projects: weekProjects },
      projects: {
        active: projectCount?.value ?? 0,
        openTasks: openTaskCount?.value ?? 0,
      },
      unbilledSeconds: Number(unbilled?.seconds ?? 0),
      recentInvoices,
      recentActivity,
    };
  }),
});
