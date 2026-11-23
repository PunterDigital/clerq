import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNotNull, isNull, ne, sum } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { addDays, startOfWeek } from "@/lib/week";
import { listInvoices } from "@/modules/billing/lifecycle";
import { createClient, listRecentActivity } from "@/modules/clients/service";
import { createProject } from "@/modules/projects/service";
import { createTask } from "@/modules/projects/tasks-service";
import { listEntriesBetween, logManualEntry } from "@/modules/time/service";
import type { Session } from "@/server/auth";

import { createCallerFactory } from "../init";
import { appRouter } from "./_app";

// dashboard.summary (#5695): the reads now run in parallel and the database
// counts and sums, instead of loading every invoice, project and task id.
// The numbers must not change: this compares the new procedure with the
// previous implementation (kept below as the reference) on the same data.

let pglite: PGlite;
let db: Db;
let businessId = "";
const userId = "dash-owner";

const caller = () =>
  createCallerFactory(appRouter)({
    headers: new Headers(),
    session: {
      user: { id: userId, name: "Dana", email: "dana@t.dev" },
      session: { id: "dash-session", userId },
    } as unknown as Session,
  });

// The summary as it was computed before #5695, minus the procedure wrapper.
async function referenceSummary(now: Date) {
  const weekStart = startOfWeek(now);
  const invoices = await listInvoices(db, businessId, now);
  const outstanding = invoices.filter((inv) => inv.status === "sent" || inv.status === "overdue");
  const byCurrency = new Map<string, number>();
  for (const inv of outstanding) {
    byCurrency.set(
      inv.currency,
      (byCurrency.get(inv.currency) ?? 0) + inv.totalMinor - inv.creditedMinor,
    );
  }
  const weekEntries = await listEntriesBetween(db, businessId, userId, weekStart, addDays(weekStart, 7));
  const projectRows = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(and(eq(schema.project.businessId, businessId), eq(schema.project.status, "active")));
  const openTaskRows = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(and(eq(schema.task.businessId, businessId), ne(schema.task.status, "done")));
  const unbilledRows = await db
    .select({ seconds: sum(schema.timeEntry.durationSeconds) })
    .from(schema.timeEntry)
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.billable, true),
        isNotNull(schema.timeEntry.endedAt),
        isNull(schema.timeEntry.invoiceLineId),
      ),
    );
  return {
    outstanding: {
      totals: [...byCurrency.entries()].map(([currency, totalMinor]) => ({ currency, totalMinor })),
      count: outstanding.length,
      overdueCount: outstanding.filter((inv) => inv.status === "overdue").length,
    },
    week: {
      seconds: weekEntries.reduce((t, e) => t + (e.durationSeconds ?? 0), 0),
      projects: new Set(weekEntries.map((e) => e.projectId)).size,
    },
    projects: { active: projectRows.length, openTasks: openTaskRows.length },
    unbilledSeconds: Number(unbilledRows[0]?.seconds ?? 0),
    recentInvoices: invoices.slice(0, 5),
    recentActivity: await listRecentActivity(db, businessId, 6),
  };
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);
  await db.insert(schema.user).values({ id: userId, name: "Dana", email: "dana@t.dev" });
  const [biz] = await db
    .insert(schema.business)
    .values({ name: "Dash Co", currency: "EUR" })
    .returning();
  businessId = biz.id;
  await db.insert(schema.businessMember).values({ businessId, userId, role: "owner" });

  const client = await createClient(db, businessId, userId, { name: "Acme", contacts: [] });
  const other = await createClient(db, businessId, userId, { name: "Globex", contacts: [] });
  const active = (await createProject(db, businessId, userId, {
    name: "Site",
    clientId: client.id,
    status: "active",
  })) as { id: string };
  await createProject(db, businessId, userId, { name: "App", clientId: other.id, status: "active" });
  await createProject(db, businessId, userId, { name: "Old", clientId: other.id, status: "completed" });
  const tasks = [];
  for (const [title, status] of [
    ["A", "todo"],
    ["B", "in_progress"],
    ["C", "in_review"],
    ["D", "done"],
  ] as const) {
    tasks.push((await createTask(db, businessId, active.id, { title, status })) as { id: string });
  }
  const monday = startOfWeek(new Date());
  await logManualEntry(db, businessId, userId, {
    taskId: tasks[0].id,
    startedAt: addDays(monday, 0),
    durationSeconds: 5400,
    billable: true,
  });
  await logManualEntry(db, businessId, userId, {
    taskId: tasks[1].id,
    startedAt: new Date(monday.getTime() + 4 * 3600_000),
    durationSeconds: 1800,
    billable: false,
  });
  await logManualEntry(db, businessId, userId, {
    taskId: tasks[2].id,
    startedAt: addDays(monday, -10),
    durationSeconds: 3600,
    billable: true,
  });

  // Seven invoices (more than the five shown): outstanding in two
  // currencies, one credited in part, one past due (refreshed to overdue),
  // plus paid, void and draft ones that don't count.
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  type Row = Pick<
    typeof schema.invoice.$inferInsert,
    "status" | "currency" | "totalMinor" | "creditedMinor" | "dueDate"
  >;
  const plain: Row[] = [
    { status: "sent", currency: "EUR", totalMinor: 100_000, creditedMinor: 20_000, dueDate: addDays(new Date(), 10) },
    { status: "sent", currency: "GBP", totalMinor: 50_000, dueDate: addDays(new Date(), -3) },
    { status: "overdue", currency: "EUR", totalMinor: 7_500, dueDate: addDays(new Date(), -30) },
    { status: "paid", currency: "EUR", totalMinor: 9_900 },
    { status: "void", currency: "USD", totalMinor: 1_000 },
    { status: "draft", currency: "EUR", totalMinor: 0 },
    { status: "sent", currency: "USD", totalMinor: 12_345, dueDate: addDays(new Date(), 5) },
  ];
  const rows = plain.map((row, i) => ({
    businessId,
    clientId: i % 2 ? other.id : client.id,
    taxTreatment: "zero_rated" as const,
    subtotalMinor: row.totalMinor,
    issueDate: day(i + 1),
    createdAt: day(i + 1),
    number: row.status === "draft" ? null : `INV-${i + 1}`,
    ...row,
  }));
  await db.insert(schema.invoice).values(rows);
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("dashboard.summary", () => {
  it("returns what the previous implementation returned", async () => {
    const summary = await caller().dashboard.summary();
    const reference = await referenceSummary(new Date());
    expect(summary).toEqual(reference);
  });

  it("adds up the outstanding invoices per currency, credits taken off, overdue refreshed", async () => {
    const summary = await caller().dashboard.summary();
    expect(summary.outstanding).toEqual({
      // Newest outstanding first: USD (Oct 7), EUR (Oct 3 and Oct 1), GBP (Oct 2).
      totals: [
        { currency: "USD", totalMinor: 12_345 },
        { currency: "EUR", totalMinor: 80_000 + 7_500 },
        { currency: "GBP", totalMinor: 50_000 },
      ],
      count: 4,
      overdueCount: 2,
    });
    expect(summary.projects).toEqual({ active: 2, openTasks: 3 });
    expect(summary.unbilledSeconds).toBe(5400 + 3600);
    expect(summary.week).toEqual({ seconds: 5400 + 1800, projects: 1 });
    expect(summary.recentInvoices.map((inv) => inv.number)).toEqual([
      "INV-7",
      null,
      "INV-5",
      "INV-4",
      "INV-3",
    ]);
  });
});
