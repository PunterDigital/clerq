// Support impersonation: a platform admin viewing the app as another user to
// diagnose a problem they reported. The admin stays signed in as themselves;
// an active row in `impersonation` for their session makes every request on
// that session resolve to the target user instead (server/session.ts).
// Impersonation is read-only: sessionProcedure refuses every mutation while
// it is active, so nothing can be changed in the target's name. Each row is
// also the audit record (who, whom, why, when), listed on the user's System
// Administration page.

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@/db";
import { schema } from "@/db";

import { getUserSuspension, isPlatformAdmin } from "./service";

// How long one impersonation lasts before it ends by itself.
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

export type ActiveImpersonation = {
  id: string;
  adminUserId: string;
  adminName: string;
  targetUserId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
};

export type StartImpersonationResult =
  | { ok: true; impersonationId: string }
  | {
      ok: false;
      reason: "not_found" | "self" | "platform_admin" | "suspended";
    };

export async function startImpersonation(
  db: Db,
  input: {
    adminUserId: string;
    adminSessionId: string;
    targetUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<StartImpersonationResult> {
  const now = input.now ?? new Date();
  if (input.targetUserId === input.adminUserId) {
    return { ok: false, reason: "self" };
  }
  const [target] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, input.targetUserId));
  if (!target) return { ok: false, reason: "not_found" };
  // Another admin's account would hand over System Administration views,
  // and a suspended account can't use the app at all, so neither helps.
  if (await isPlatformAdmin(db, input.targetUserId)) {
    return { ok: false, reason: "platform_admin" };
  }
  if (await getUserSuspension(db, input.targetUserId)) {
    return { ok: false, reason: "suspended" };
  }

  // One live impersonation per admin session: starting a new one ends any
  // earlier one still open on it.
  await db
    .update(schema.impersonation)
    .set({ endedAt: now })
    .where(
      and(
        eq(schema.impersonation.adminSessionId, input.adminSessionId),
        isNull(schema.impersonation.endedAt),
      ),
    );

  const [row] = await db
    .insert(schema.impersonation)
    .values({
      adminUserId: input.adminUserId,
      adminSessionId: input.adminSessionId,
      targetUserId: input.targetUserId,
      reason: input.reason,
      startedAt: now,
      expiresAt: new Date(now.getTime() + IMPERSONATION_TTL_MS),
    })
    .returning({ id: schema.impersonation.id });
  return { ok: true, impersonationId: row.id };
}

// The live impersonation on an admin's session, if any: not ended and not
// expired. Called on every request, so it is one indexed lookup.
export async function getActiveImpersonation(
  db: Db,
  adminSessionId: string,
  now: Date = new Date(),
): Promise<ActiveImpersonation | null> {
  const [row] = await db
    .select({
      id: schema.impersonation.id,
      adminUserId: schema.impersonation.adminUserId,
      adminName: schema.user.name,
      targetUserId: schema.impersonation.targetUserId,
      reason: schema.impersonation.reason,
      startedAt: schema.impersonation.startedAt,
      expiresAt: schema.impersonation.expiresAt,
    })
    .from(schema.impersonation)
    .innerJoin(schema.user, eq(schema.impersonation.adminUserId, schema.user.id))
    .where(
      and(
        eq(schema.impersonation.adminSessionId, adminSessionId),
        isNull(schema.impersonation.endedAt),
        gt(schema.impersonation.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.impersonation.startedAt))
    .limit(1);
  return row ?? null;
}

// Ends an impersonation. Scoped to the admin's session so one session can
// never end (or learn about) another's.
export async function endImpersonation(
  db: Db,
  impersonationId: string,
  adminSessionId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean }> {
  const ended = await db
    .update(schema.impersonation)
    .set({ endedAt: now })
    .where(
      and(
        eq(schema.impersonation.id, impersonationId),
        eq(schema.impersonation.adminSessionId, adminSessionId),
        isNull(schema.impersonation.endedAt),
      ),
    )
    .returning({ id: schema.impersonation.id });
  return { ok: ended.length > 0 };
}

export type ImpersonationRecord = {
  id: string;
  adminUserId: string;
  adminName: string;
  reason: string;
  startedAt: Date;
  // When it stopped: ended by the admin, or the expiry when it ran out.
  // Null while still live.
  endedAt: Date | null;
  endedBy: "admin" | "expired" | null;
};

// The audit history for one user, newest first.
export async function listImpersonationsOf(
  db: Db,
  targetUserId: string,
  now: Date = new Date(),
  limit = 20,
): Promise<ImpersonationRecord[]> {
  const admin = alias(schema.user, "admin");
  const rows = await db
    .select({
      id: schema.impersonation.id,
      adminUserId: schema.impersonation.adminUserId,
      adminName: admin.name,
      reason: schema.impersonation.reason,
      startedAt: schema.impersonation.startedAt,
      expiresAt: schema.impersonation.expiresAt,
      endedAt: schema.impersonation.endedAt,
    })
    .from(schema.impersonation)
    .innerJoin(admin, eq(schema.impersonation.adminUserId, admin.id))
    .where(eq(schema.impersonation.targetUserId, targetUserId))
    .orderBy(desc(schema.impersonation.startedAt))
    .limit(limit);
  return rows.map(({ expiresAt, endedAt, ...row }) => {
    if (endedAt && endedAt <= expiresAt) {
      return { ...row, endedAt, endedBy: "admin" as const };
    }
    if (expiresAt <= now) {
      return { ...row, endedAt: expiresAt, endedBy: "expired" as const };
    }
    return { ...row, endedAt: null, endedBy: null };
  });
}
