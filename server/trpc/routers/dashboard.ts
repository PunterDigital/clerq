import { and, eq, isNotNull, isNull, ne, sum } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { listInvoices } from "@/modules/billing/lifecycle";
import { listRecentActivity } from "@/modules/clients/service";
import { listEntriesBetween } from "@/modules/time/service";
import { addDays, startOfWeek } from "@/lib/week";

import { createTRPCRouter, permissionProcedure } from "../init";

export const dashboardRouter = createTRPCRouter({
  // One round trip for the whole dashboard. Aggregation only - every
  // number is composed from module services or scoped queries.
  summary: permissionProcedure("dashboard.view").query(async ({ ctx }) => {
    const db = getDb();
    const now = new Date();
    const weekStart = startOfWeek(now);

    const invoices = await listInvoices(db, ctx.businessId, now);
    const outstanding = invoices.filter(
      (inv) => inv.status === "sent" || inv.status === "overdue",
    );
    const outstandingByCurrency = new Map<string, number>();
    for (const inv of outstanding) {
      outstandingByCurrency.set(
        inv.currency,
        (outstandingByCurrency.get(inv.currency) ?? 0) +
          inv.totalMinor -
          inv.creditedMinor,
      );
    }

    const weekEntries = await listEntriesBetween(
      db,
      ctx.businessId,
      ctx.session.user.id,
      weekStart,
      addDays(weekStart, 7),
    );
    const weekSeconds = weekEntries.reduce(
      (total, entry) => total + (entry.durationSeconds ?? 0),
      0,
    );
    const weekProjects = new Set(weekEntries.map((entry) => entry.projectId))
      .size;

    const projectRows = await db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(
        and(
          eq(schema.project.businessId, ctx.businessId),
          eq(schema.project.status, "active"),
        ),
      );
    const openTaskRows = await db
      .select({ id: schema.task.id })
      .from(schema.task)
      .where(
        and(
          eq(schema.task.businessId, ctx.businessId),
          ne(schema.task.status, "done"),
        ),
      );

    const unbilledRows = await db
      .select({ seconds: sum(schema.timeEntry.durationSeconds) })
      .from(schema.timeEntry)
      .where(
        and(
          eq(schema.timeEntry.businessId, ctx.businessId),
          eq(schema.timeEntry.billable, true),
          isNotNull(schema.timeEntry.endedAt),
          isNull(schema.timeEntry.invoiceLineId),
        ),
      );
    const unbilledSeconds = Number(unbilledRows[0]?.seconds ?? 0);

    return {
      outstanding: {
        totals: [...outstandingByCurrency.entries()].map(
          ([currency, totalMinor]) => ({ currency, totalMinor }),
        ),
        count: outstanding.length,
        overdueCount: outstanding.filter((inv) => inv.status === "overdue")
          .length,
      },
      week: { seconds: weekSeconds, projects: weekProjects },
      projects: {
        active: projectRows.length,
        openTasks: openTaskRows.length,
      },
      unbilledSeconds,
      recentInvoices: invoices.slice(0, 5),
      recentActivity: await listRecentActivity(db, ctx.businessId, 6),
    };
  }),
});
