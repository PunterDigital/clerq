// Platform administration: cross-tenant statistics and moderation for
// platform admins. Unlike every other module, this one deliberately reads
// across every business - a platform admin's job is to see the whole
// instance, not one tenant's slice of it. Aggregate figures (getPlatformStats)
// must never surface anything identifying (no names, emails or business
// names) - the per-user/per-business lookups below are the only place that
// information is meant to appear, for the one-record-at-a-time moderation
// views.

import { asc, count, desc, eq, ilike, inArray, or, sum } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";
import { isRole, ROLE_META } from "@/modules/authz";

export const listQuerySchema = z.object({
  search: z.string().trim().max(320).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

function paginate(query: ListQuery) {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

function roleName(role: string, customRoleName: string | null): string {
  if (role === "custom") return customRoleName ?? "Custom role";
  return isRole(role) ? ROLE_META[role].label : "No role";
}

// Folds currency-tagged amounts into per-currency totals, sorted for
// deterministic rendering - the same shape modules/reports/profit.ts uses.
function totalsByCurrency(
  rows: { currency: string; amountMinor: number }[],
): { currency: string; totalMinor: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountMinor);
  }
  return [...totals.entries()]
    .map(([currency, totalMinor]) => ({ currency, totalMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

// ---------------------------------------------------------------------------
// Platform admin membership
// ---------------------------------------------------------------------------

export async function isPlatformAdmin(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: schema.platformAdmin.userId })
    .from(schema.platformAdmin)
    .where(eq(schema.platformAdmin.userId, userId));
  return !!row;
}

export async function listPlatformAdminIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.platformAdmin.userId })
    .from(schema.platformAdmin);
  return rows.map((r) => r.userId);
}

type GrantResult = { ok: true } | { ok: false; reason: "already_admin" };

// grantedByUserId is null only for the bootstrap script, which grants the
// first admin before any admin session exists to be the actor.
export async function grantPlatformAdmin(
  db: Db,
  targetUserId: string,
  grantedByUserId: string | null,
): Promise<GrantResult> {
  if (await isPlatformAdmin(db, targetUserId)) {
    return { ok: false, reason: "already_admin" };
  }
  await db
    .insert(schema.platformAdmin)
    .values({ userId: targetUserId, grantedByUserId });
  return { ok: true };
}

type RevokeResult =
  | { ok: true }
  | { ok: false; reason: "not_admin" | "last_admin" };

// The instance must always keep at least one platform admin - the same
// invariant modules/team/service.ts enforces for a business's last owner.
export async function revokePlatformAdmin(
  db: Db,
  targetUserId: string,
): Promise<RevokeResult> {
  return db.transaction(async (tx) => {
    const admins = await tx
      .select({ userId: schema.platformAdmin.userId })
      .from(schema.platformAdmin);
    if (!admins.some((a) => a.userId === targetUserId)) {
      return { ok: false, reason: "not_admin" };
    }
    if (admins.length <= 1) {
      return { ok: false, reason: "last_admin" };
    }
    await tx
      .delete(schema.platformAdmin)
      .where(eq(schema.platformAdmin.userId, targetUserId));
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Suspension state - read by server/trpc/init.ts on every request, so these
// stay single-row lookups by primary key.
// ---------------------------------------------------------------------------

export type Suspension = { suspendedAt: Date; reason: string | null };

export async function getUserSuspension(
  db: Db,
  userId: string,
): Promise<Suspension | null> {
  const [row] = await db
    .select({
      suspendedAt: schema.userSuspension.suspendedAt,
      reason: schema.userSuspension.reason,
    })
    .from(schema.userSuspension)
    .where(eq(schema.userSuspension.userId, userId));
  return row ?? null;
}

export async function getBusinessSuspension(
  db: Db,
  businessId: string,
): Promise<Suspension | null> {
  const [row] = await db
    .select({
      suspendedAt: schema.businessSuspension.suspendedAt,
      reason: schema.businessSuspension.reason,
    })
    .from(schema.businessSuspension)
    .where(eq(schema.businessSuspension.businessId, businessId));
  return row ?? null;
}

type SuspendUserResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "cannot_suspend_self" };

export async function suspendUser(
  db: Db,
  targetUserId: string,
  actorUserId: string,
  reason?: string,
): Promise<SuspendUserResult> {
  if (targetUserId === actorUserId) {
    return { ok: false, reason: "cannot_suspend_self" };
  }
  const [target] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, targetUserId));
  if (!target) return { ok: false, reason: "not_found" };

  await db
    .insert(schema.userSuspension)
    .values({
      userId: targetUserId,
      suspendedAt: new Date(),
      reason: reason ?? null,
      suspendedByUserId: actorUserId,
    })
    .onConflictDoUpdate({
      target: schema.userSuspension.userId,
      set: { suspendedAt: new Date(), reason: reason ?? null, suspendedByUserId: actorUserId },
    });
  return { ok: true };
}

type ReactivateResult = { ok: true } | { ok: false; reason: "not_suspended" };

export async function reactivateUser(
  db: Db,
  targetUserId: string,
): Promise<ReactivateResult> {
  const deleted = await db
    .delete(schema.userSuspension)
    .where(eq(schema.userSuspension.userId, targetUserId))
    .returning({ userId: schema.userSuspension.userId });
  if (deleted.length === 0) return { ok: false, reason: "not_suspended" };
  return { ok: true };
}

type SuspendBusinessResult = { ok: true } | { ok: false; reason: "not_found" };

export async function suspendBusiness(
  db: Db,
  businessId: string,
  actorUserId: string,
  reason?: string,
): Promise<SuspendBusinessResult> {
  const [target] = await db
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  if (!target) return { ok: false, reason: "not_found" };

  await db
    .insert(schema.businessSuspension)
    .values({
      businessId,
      suspendedAt: new Date(),
      reason: reason ?? null,
      suspendedByUserId: actorUserId,
    })
    .onConflictDoUpdate({
      target: schema.businessSuspension.businessId,
      set: { suspendedAt: new Date(), reason: reason ?? null, suspendedByUserId: actorUserId },
    });
  return { ok: true };
}

export async function reactivateBusiness(
  db: Db,
  businessId: string,
): Promise<ReactivateResult> {
  const deleted = await db
    .delete(schema.businessSuspension)
    .where(eq(schema.businessSuspension.businessId, businessId))
    .returning({ businessId: schema.businessSuspension.businessId });
  if (deleted.length === 0) return { ok: false, reason: "not_suspended" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Aggregate, non-identifying platform statistics
// ---------------------------------------------------------------------------

export type PlatformStats = {
  userCount: number;
  businessCount: number;
  invoiceCount: number;
  invoicedTotals: { currency: string; totalMinor: number }[];
  expenseCount: number;
  expenseTotals: { currency: string; totalMinor: number }[];
  timeTrackedSeconds: number;
};

export async function getPlatformStats(db: Db): Promise<PlatformStats> {
  const [[userRow], [businessRow], invoiceRows, expenseRows, [timeRow]] =
    await Promise.all([
      db.select({ total: count() }).from(schema.user),
      db.select({ total: count() }).from(schema.business),
      db
        .select({
          currency: schema.invoice.currency,
          totalMinor: schema.invoice.totalMinor,
          creditedMinor: schema.invoice.creditedMinor,
          status: schema.invoice.status,
        })
        .from(schema.invoice),
      db
        .select({
          currency: schema.expense.currency,
          amountMinor: schema.expense.amountMinor,
        })
        .from(schema.expense),
      db.select({ seconds: sum(schema.timeEntry.durationSeconds) }).from(schema.timeEntry),
    ]);

  // "Invoiced" excludes drafts (never sent) and voided invoices (withdrawn),
  // matching modules/reports/profit.ts's definition of recognised income.
  const invoiced = invoiceRows
    .filter((inv) => inv.status !== "draft" && inv.status !== "void")
    // Net of credit notes (#5042).
    .map((inv) => ({
      currency: inv.currency,
      amountMinor: inv.totalMinor - inv.creditedMinor,
    }));

  return {
    userCount: userRow?.total ?? 0,
    businessCount: businessRow?.total ?? 0,
    invoiceCount: invoiceRows.length,
    invoicedTotals: totalsByCurrency(invoiced),
    expenseCount: expenseRows.length,
    expenseTotals: totalsByCurrency(expenseRows),
    timeTrackedSeconds: Number(timeRow?.seconds ?? 0),
  };
}

// ---------------------------------------------------------------------------
// User moderation
// ---------------------------------------------------------------------------

export type UserListItem = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  businessCount: number;
  suspended: boolean;
  isPlatformAdmin: boolean;
};

// Paginates the user list, then resolves membership counts, suspension and
// admin status for just that page - a join-then-group-by across a LIMIT would
// either lose the pagination or require a second query anyway.
export async function listUsers(db: Db, query: ListQuery): Promise<Page<UserListItem>> {
  const { limit, offset } = paginate(query);
  const searchFilter = query.search
    ? or(
        ilike(schema.user.name, `%${query.search}%`),
        ilike(schema.user.email, `%${query.search}%`),
      )
    : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .where(searchFilter)
      .orderBy(desc(schema.user.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(schema.user).where(searchFilter),
  ]);

  const ids = rows.map((r) => r.id);
  const total = totalRow?.total ?? 0;
  if (ids.length === 0) {
    return { items: [], total, page: query.page, pageSize: query.pageSize };
  }

  const [membershipCounts, suspensions, admins] = await Promise.all([
    db
      .select({ userId: schema.businessMember.userId, total: count() })
      .from(schema.businessMember)
      .where(inArray(schema.businessMember.userId, ids))
      .groupBy(schema.businessMember.userId),
    db
      .select({ userId: schema.userSuspension.userId })
      .from(schema.userSuspension)
      .where(inArray(schema.userSuspension.userId, ids)),
    db
      .select({ userId: schema.platformAdmin.userId })
      .from(schema.platformAdmin)
      .where(inArray(schema.platformAdmin.userId, ids)),
  ]);

  const membershipByUser = new Map(membershipCounts.map((m) => [m.userId, m.total]));
  const suspendedSet = new Set(suspensions.map((s) => s.userId));
  const adminSet = new Set(admins.map((a) => a.userId));

  return {
    items: rows.map((r) => ({
      ...r,
      businessCount: membershipByUser.get(r.id) ?? 0,
      suspended: suspendedSet.has(r.id),
      isPlatformAdmin: adminSet.has(r.id),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export type UserDetail = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  isPlatformAdmin: boolean;
  suspension: Suspension | null;
  businesses: { businessId: string; name: string; role: string; roleName: string }[];
};

export async function getUserDetail(db: Db, userId: string): Promise<UserDetail | null> {
  const [user] = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      emailVerified: schema.user.emailVerified,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!user) return null;

  const [suspension, admin, businessRows] = await Promise.all([
    getUserSuspension(db, userId),
    isPlatformAdmin(db, userId),
    db
      .select({
        businessId: schema.business.id,
        name: schema.business.name,
        role: schema.businessMember.role,
        customRoleName: schema.businessRole.name,
      })
      .from(schema.businessMember)
      .innerJoin(schema.business, eq(schema.businessMember.businessId, schema.business.id))
      .leftJoin(schema.businessRole, eq(schema.businessMember.businessRoleId, schema.businessRole.id))
      .where(eq(schema.businessMember.userId, userId))
      .orderBy(asc(schema.businessMember.createdAt)),
  ]);

  return {
    ...user,
    isPlatformAdmin: admin,
    suspension,
    businesses: businessRows.map((b) => ({
      businessId: b.businessId,
      name: b.name,
      role: b.role,
      roleName: roleName(b.role, b.customRoleName),
    })),
  };
}

// ---------------------------------------------------------------------------
// Business moderation
// ---------------------------------------------------------------------------

export type BusinessListItem = {
  id: string;
  name: string;
  currency: string;
  createdAt: Date;
  memberCount: number;
  suspended: boolean;
};

export async function listBusinesses(
  db: Db,
  query: ListQuery,
): Promise<Page<BusinessListItem>> {
  const { limit, offset } = paginate(query);
  const searchFilter = query.search
    ? ilike(schema.business.name, `%${query.search}%`)
    : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: schema.business.id,
        name: schema.business.name,
        currency: schema.business.currency,
        createdAt: schema.business.createdAt,
      })
      .from(schema.business)
      .where(searchFilter)
      .orderBy(desc(schema.business.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(schema.business).where(searchFilter),
  ]);

  const ids = rows.map((r) => r.id);
  const total = totalRow?.total ?? 0;
  if (ids.length === 0) {
    return { items: [], total, page: query.page, pageSize: query.pageSize };
  }

  const [memberCounts, suspensions] = await Promise.all([
    db
      .select({ businessId: schema.businessMember.businessId, total: count() })
      .from(schema.businessMember)
      .where(inArray(schema.businessMember.businessId, ids))
      .groupBy(schema.businessMember.businessId),
    db
      .select({ businessId: schema.businessSuspension.businessId })
      .from(schema.businessSuspension)
      .where(inArray(schema.businessSuspension.businessId, ids)),
  ]);

  const memberByBusiness = new Map(memberCounts.map((m) => [m.businessId, m.total]));
  const suspendedSet = new Set(suspensions.map((s) => s.businessId));

  return {
    items: rows.map((r) => ({
      ...r,
      memberCount: memberByBusiness.get(r.id) ?? 0,
      suspended: suspendedSet.has(r.id),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export type BusinessDetail = {
  id: string;
  name: string;
  currency: string;
  createdAt: Date;
  suspension: Suspension | null;
  members: {
    userId: string;
    name: string;
    email: string;
    role: string;
    roleName: string;
    joinedAt: Date;
  }[];
  stats: {
    invoiceCount: number;
    invoicedTotals: { currency: string; totalMinor: number }[];
    expenseCount: number;
    expenseTotals: { currency: string; totalMinor: number }[];
    timeTrackedSeconds: number;
  };
};

export async function getBusinessDetail(
  db: Db,
  businessId: string,
): Promise<BusinessDetail | null> {
  const [business] = await db
    .select({
      id: schema.business.id,
      name: schema.business.name,
      currency: schema.business.currency,
      createdAt: schema.business.createdAt,
    })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  if (!business) return null;

  const [suspension, memberRows, invoiceRows, expenseRows, [timeRow]] = await Promise.all([
    getBusinessSuspension(db, businessId),
    db
      .select({
        userId: schema.businessMember.userId,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.businessMember.role,
        customRoleName: schema.businessRole.name,
        joinedAt: schema.businessMember.createdAt,
      })
      .from(schema.businessMember)
      .innerJoin(schema.user, eq(schema.businessMember.userId, schema.user.id))
      .leftJoin(schema.businessRole, eq(schema.businessMember.businessRoleId, schema.businessRole.id))
      .where(eq(schema.businessMember.businessId, businessId))
      .orderBy(asc(schema.businessMember.createdAt)),
    db
      .select({
        currency: schema.invoice.currency,
        totalMinor: schema.invoice.totalMinor,
        creditedMinor: schema.invoice.creditedMinor,
        status: schema.invoice.status,
      })
      .from(schema.invoice)
      .where(eq(schema.invoice.businessId, businessId)),
    db
      .select({ currency: schema.expense.currency, amountMinor: schema.expense.amountMinor })
      .from(schema.expense)
      .where(eq(schema.expense.businessId, businessId)),
    db
      .select({ seconds: sum(schema.timeEntry.durationSeconds) })
      .from(schema.timeEntry)
      .where(eq(schema.timeEntry.businessId, businessId)),
  ]);

  const invoiced = invoiceRows
    .filter((inv) => inv.status !== "draft" && inv.status !== "void")
    // Net of credit notes (#5042).
    .map((inv) => ({
      currency: inv.currency,
      amountMinor: inv.totalMinor - inv.creditedMinor,
    }));

  return {
    ...business,
    suspension,
    members: memberRows.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      roleName: roleName(m.role, m.customRoleName),
      joinedAt: m.joinedAt,
    })),
    stats: {
      invoiceCount: invoiceRows.length,
      invoicedTotals: totalsByCurrency(invoiced),
      expenseCount: expenseRows.length,
      expenseTotals: totalsByCurrency(expenseRows),
      timeTrackedSeconds: Number(timeRow?.seconds ?? 0),
    },
  };
}
