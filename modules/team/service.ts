import { randomBytes } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";
import {
  ROLES,
  sanitizePermissions,
  type Permission,
  type PermissionEffect,
  type Role,
  type StoredRole,
} from "@/modules/authz";

// Team membership and invitations. Every query is scoped by businessId (the
// tenancy boundary), except invitation lookup by token - the token is itself
// the unguessable secret that authorises the accept.

const INVITE_TTL_DAYS = 7;

export const roleSchema = z.enum(ROLES);

export const inviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // A predefined role key or a custom role id; resolved by the router.
  role: z.string().trim().min(1).default("member"),
});

// What the router passes to inviteMember once it has resolved the wire role
// into a stored role plus (for custom roles) the business_role id.
export type ResolvedRole = { role: StoredRole; businessRoleId: string | null };

export type InviteInput = z.infer<typeof inviteInputSchema>;

// Current members with their user details, oldest first (the founder leads).
export async function listMembers(db: Db, businessId: string) {
  return db
    .select({
      businessMemberId: schema.businessMember.id,
      userId: schema.businessMember.userId,
      role: schema.businessMember.role,
      businessRoleId: schema.businessMember.businessRoleId,
      joinedAt: schema.businessMember.createdAt,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.businessMember)
    .innerJoin(schema.user, eq(schema.businessMember.userId, schema.user.id))
    .where(eq(schema.businessMember.businessId, businessId))
    .orderBy(asc(schema.businessMember.createdAt));
}

// Custom roles defined by the business, oldest first.
export async function listCustomRoles(db: Db, businessId: string) {
  const rows = await db
    .select({
      id: schema.businessRole.id,
      name: schema.businessRole.name,
      permissions: schema.businessRole.permissions,
    })
    .from(schema.businessRole)
    .where(eq(schema.businessRole.businessId, businessId))
    .orderBy(asc(schema.businessRole.createdAt));
  // Sanitise on read so a retired permission never surfaces as granted.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: sanitizePermissions((r.permissions as string[]) ?? []),
  }));
}

export async function getCustomRole(
  db: Db,
  businessId: string,
  roleId: string,
) {
  const [row] = await db
    .select({
      id: schema.businessRole.id,
      permissions: schema.businessRole.permissions,
    })
    .from(schema.businessRole)
    .where(
      and(
        eq(schema.businessRole.businessId, businessId),
        eq(schema.businessRole.id, roleId),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    permissions: sanitizePermissions((row.permissions as string[]) ?? []),
  };
}

type CustomRoleResult =
  | { ok: true; id: string }
  | { ok: false; reason: "duplicate_name" | "not_found" | "in_use" };

export async function createCustomRole(
  db: Db,
  businessId: string,
  name: string,
  permissions: Permission[],
): Promise<CustomRoleResult> {
  // The unique (business_id, name) index is the source of truth for dupes.
  const existing = await db
    .select({ id: schema.businessRole.id })
    .from(schema.businessRole)
    .where(
      and(
        eq(schema.businessRole.businessId, businessId),
        eq(schema.businessRole.name, name),
      ),
    );
  if (existing.length > 0) return { ok: false, reason: "duplicate_name" };

  const [created] = await db
    .insert(schema.businessRole)
    .values({ businessId, name, permissions: sanitizePermissions(permissions) })
    .returning({ id: schema.businessRole.id });
  return { ok: true, id: created.id };
}

export async function updateCustomRole(
  db: Db,
  businessId: string,
  roleId: string,
  name: string,
  permissions: Permission[],
): Promise<CustomRoleResult> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.businessRole.id })
      .from(schema.businessRole)
      .where(
        and(
          eq(schema.businessRole.businessId, businessId),
          eq(schema.businessRole.id, roleId),
        ),
      );
    if (!role) return { ok: false, reason: "not_found" };

    const clash = await tx
      .select({ id: schema.businessRole.id })
      .from(schema.businessRole)
      .where(
        and(
          eq(schema.businessRole.businessId, businessId),
          eq(schema.businessRole.name, name),
        ),
      );
    if (clash.some((r) => r.id !== roleId)) {
      return { ok: false, reason: "duplicate_name" };
    }

    await tx
      .update(schema.businessRole)
      .set({
        name,
        permissions: sanitizePermissions(permissions),
        updatedAt: new Date(),
      })
      .where(eq(schema.businessRole.id, roleId));
    return { ok: true, id: roleId };
  });
}

export async function deleteCustomRole(
  db: Db,
  businessId: string,
  roleId: string,
): Promise<CustomRoleResult> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.businessRole.id })
      .from(schema.businessRole)
      .where(
        and(
          eq(schema.businessRole.businessId, businessId),
          eq(schema.businessRole.id, roleId),
        ),
      );
    if (!role) return { ok: false, reason: "not_found" };

    // A role still held by someone can't be deleted - reassign those members
    // first, so nobody is silently left without permissions.
    const inUse = await tx
      .select({ id: schema.businessMember.id })
      .from(schema.businessMember)
      .where(eq(schema.businessMember.businessRoleId, roleId));
    if (inUse.length > 0) return { ok: false, reason: "in_use" };

    await tx
      .delete(schema.businessRole)
      .where(eq(schema.businessRole.id, roleId));
    return { ok: true, id: roleId };
  });
}

// Every per-member permission override for the business, for the management
// UI. Scoped by businessId (the tenancy boundary).
export async function listMemberOverrides(db: Db, businessId: string) {
  return db
    .select({
      businessMemberId: schema.businessMemberPermission.businessMemberId,
      permission: schema.businessMemberPermission.permission,
      effect: schema.businessMemberPermission.effect,
    })
    .from(schema.businessMemberPermission)
    .where(eq(schema.businessMemberPermission.businessId, businessId));
}

// Pending invitations for the business, newest first. Carries the token so an
// owner can re-copy the link; only ever returned to owners (router-enforced).
export async function listPendingInvitations(db: Db, businessId: string) {
  return db
    .select()
    .from(schema.businessInvitation)
    .where(
      and(
        eq(schema.businessInvitation.businessId, businessId),
        eq(schema.businessInvitation.status, "pending"),
      ),
    )
    .orderBy(asc(schema.businessInvitation.createdAt));
}

type InviteResult =
  | { ok: true; invitation: typeof schema.businessInvitation.$inferSelect }
  | { ok: false; reason: "already_member" | "already_invited" };

export async function inviteMember(
  db: Db,
  businessId: string,
  invitedByUserId: string,
  input: { email: string; role: StoredRole; businessRoleId?: string | null },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();

  // Already on the team? (case-insensitive email match against members)
  const members = await db
    .select({ email: schema.user.email })
    .from(schema.businessMember)
    .innerJoin(schema.user, eq(schema.businessMember.userId, schema.user.id))
    .where(eq(schema.businessMember.businessId, businessId));
  if (members.some((m) => m.email.trim().toLowerCase() === email)) {
    return { ok: false, reason: "already_member" };
  }

  // One live invite per email - revoke the old one first to re-invite.
  const pending = await listPendingInvitations(db, businessId);
  if (pending.some((p) => p.email === email)) {
    return { ok: false, reason: "already_invited" };
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000);
  const [invitation] = await db
    .insert(schema.businessInvitation)
    .values({
      businessId,
      email,
      role: input.role,
      businessRoleId: input.businessRoleId ?? null,
      token: randomBytes(24).toString("base64url"),
      invitedByUserId,
      expiresAt,
    })
    .returning();
  return { ok: true, invitation };
}

export async function revokeInvitation(
  db: Db,
  businessId: string,
  invitationId: string,
) {
  const [updated] = await db
    .update(schema.businessInvitation)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(schema.businessInvitation.businessId, businessId),
        eq(schema.businessInvitation.id, invitationId),
        eq(schema.businessInvitation.status, "pending"),
      ),
    )
    .returning();
  return updated ?? null;
}

// Token lookup for the accept screen. Unscoped by business on purpose: the
// token is the credential. Returns just enough to render the invite, plus a
// computed validity so the page can branch without re-deriving the rules.
export async function getInvitationPreview(db: Db, token: string) {
  const [row] = await db
    .select({
      email: schema.businessInvitation.email,
      role: schema.businessInvitation.role,
      status: schema.businessInvitation.status,
      expiresAt: schema.businessInvitation.expiresAt,
      businessName: schema.business.name,
    })
    .from(schema.businessInvitation)
    .innerJoin(
      schema.business,
      eq(schema.businessInvitation.businessId, schema.business.id),
    )
    .where(eq(schema.businessInvitation.token, token));
  if (!row) return null;
  const valid = row.status === "pending" && row.expiresAt > new Date();
  return { ...row, valid };
}

type AcceptResult =
  | { ok: true; businessId: string; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "expired" | "not_pending" };

// Accept by token. The accepting user need not already belong to any business
// (a fresh sign-up joining their first team), so this is authed-only, not
// business-scoped. Idempotent: re-accepting when already a member is a no-op
// success, never a duplicate membership.
export async function acceptInvitation(
  db: Db,
  userId: string,
  token: string,
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(schema.businessInvitation)
      .where(eq(schema.businessInvitation.token, token));
    if (!invite) return { ok: false, reason: "invalid" };
    if (invite.status !== "pending") return { ok: false, reason: "not_pending" };
    if (invite.expiresAt <= new Date()) return { ok: false, reason: "expired" };

    const [existing] = await tx
      .select({ id: schema.businessMember.id })
      .from(schema.businessMember)
      .where(
        and(
          eq(schema.businessMember.businessId, invite.businessId),
          eq(schema.businessMember.userId, userId),
        ),
      );
    if (!existing) {
      await tx.insert(schema.businessMember).values({
        businessId: invite.businessId,
        userId,
        role: invite.role,
        businessRoleId: invite.businessRoleId,
      });
    }
    await tx
      .update(schema.businessInvitation)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(eq(schema.businessInvitation.id, invite.id));

    return { ok: true, businessId: invite.businessId, alreadyMember: !!existing };
  });
}

type RemoveResult =
  | { ok: true }
  | { ok: false; reason: "not_member" | "last_owner" };

// Remove a member. The last owner cannot be removed - a business must always
// have someone who can administer it.
export async function removeMember(
  db: Db,
  businessId: string,
  targetUserId: string,
): Promise<RemoveResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        userId: schema.businessMember.userId,
        role: schema.businessMember.role,
      })
      .from(schema.businessMember)
      .where(eq(schema.businessMember.businessId, businessId));

    const target = rows.find((r) => r.userId === targetUserId);
    if (!target) return { ok: false, reason: "not_member" };
    const owners = rows.filter((r) => r.role === "owner");
    if (target.role === "owner" && owners.length <= 1) {
      return { ok: false, reason: "last_owner" };
    }

    await tx
      .delete(schema.businessMember)
      .where(
        and(
          eq(schema.businessMember.businessId, businessId),
          eq(schema.businessMember.userId, targetUserId),
        ),
      );
    return { ok: true };
  });
}

type SetRoleResult =
  | { ok: true }
  | { ok: false; reason: "not_member" | "last_owner" };

// Change a member's role. Like removal, this protects the last owner: the
// business must always keep someone who holds the ownership invariants.
// Caller-side guards (who may assign which role, not touching yourself) live
// in the router; this enforces the data-integrity rule.
export async function setMemberRole(
  db: Db,
  businessId: string,
  targetUserId: string,
  role: Role,
): Promise<SetRoleResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        userId: schema.businessMember.userId,
        role: schema.businessMember.role,
      })
      .from(schema.businessMember)
      .where(eq(schema.businessMember.businessId, businessId));

    const target = rows.find((r) => r.userId === targetUserId);
    if (!target) return { ok: false, reason: "not_member" };
    if (target.role === role) return { ok: true };

    const owners = rows.filter((r) => r.role === "owner");
    if (target.role === "owner" && role !== "owner" && owners.length <= 1) {
      return { ok: false, reason: "last_owner" };
    }

    await tx
      .update(schema.businessMember)
      // Clear any custom-role link: a predefined role and a custom role are
      // mutually exclusive.
      .set({ role, businessRoleId: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.businessMember.businessId, businessId),
          eq(schema.businessMember.userId, targetUserId),
        ),
      );
    return { ok: true };
  });
}

type SetCustomRoleResult =
  | { ok: true }
  | { ok: false; reason: "not_member" | "role_not_found" | "last_owner" };

// Assign a business-defined custom role to a member. Custom roles are never
// the owner wildcard, so assigning one to the last owner would leave the
// business unadministerable - blocked, like demotion.
export async function setMemberCustomRole(
  db: Db,
  businessId: string,
  targetUserId: string,
  customRoleId: string,
): Promise<SetCustomRoleResult> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.businessRole.id })
      .from(schema.businessRole)
      .where(
        and(
          eq(schema.businessRole.businessId, businessId),
          eq(schema.businessRole.id, customRoleId),
        ),
      );
    if (!role) return { ok: false, reason: "role_not_found" };

    const rows = await tx
      .select({
        userId: schema.businessMember.userId,
        role: schema.businessMember.role,
      })
      .from(schema.businessMember)
      .where(eq(schema.businessMember.businessId, businessId));

    const target = rows.find((r) => r.userId === targetUserId);
    if (!target) return { ok: false, reason: "not_member" };

    const owners = rows.filter((r) => r.role === "owner");
    if (target.role === "owner" && owners.length <= 1) {
      return { ok: false, reason: "last_owner" };
    }

    await tx
      .update(schema.businessMember)
      .set({ role: "custom", businessRoleId: customRoleId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.businessMember.businessId, businessId),
          eq(schema.businessMember.userId, targetUserId),
        ),
      );
    return { ok: true };
  });
}

type SetPermissionResult =
  | { ok: true }
  | { ok: false; reason: "not_member" };

// Set or clear a single per-member permission override. effect null removes
// the override (back to the role default); "grant"/"deny" upserts it. Scoped
// by businessId; the row's businessMemberId is resolved here so callers only
// deal in userIds.
export async function setMemberPermission(
  db: Db,
  businessId: string,
  targetUserId: string,
  permission: Permission,
  effect: PermissionEffect | null,
): Promise<SetPermissionResult> {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: schema.businessMember.id })
      .from(schema.businessMember)
      .where(
        and(
          eq(schema.businessMember.businessId, businessId),
          eq(schema.businessMember.userId, targetUserId),
        ),
      );
    if (!member) return { ok: false, reason: "not_member" };

    // Replace any existing override for this permission (the unique index is
    // on member+permission), then add the new one when an effect is set.
    await tx
      .delete(schema.businessMemberPermission)
      .where(
        and(
          eq(schema.businessMemberPermission.businessMemberId, member.id),
          eq(schema.businessMemberPermission.permission, permission),
        ),
      );
    if (effect) {
      await tx.insert(schema.businessMemberPermission).values({
        businessId,
        businessMemberId: member.id,
        permission,
        effect,
      });
    }
    return { ok: true };
  });
}
