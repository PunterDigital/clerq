import { and, asc, eq } from "drizzle-orm";

import { getDb, schema, type Db } from "@/db";
import {
  applyOverrides,
  isPermission,
  isRole,
  permissionsForRole,
  ROLE_META,
  sanitizePermissions,
  type Permission,
  type PermissionEffect,
  type StoredRole,
} from "@/modules/authz";

export type ActiveMembership = {
  businessMemberId: string;
  businessId: string;
  role: StoredRole;
  // Set when role is "custom": the business-defined role the member holds.
  customRoleId: string | null;
  // Human label for the member's role (a predefined role label or the custom
  // role's name), for display.
  roleName: string;
  // The member's resolved permissions: their role's set (predefined or custom)
  // with per-member overrides applied (see modules/authz). Every
  // business-scoped procedure gates on this.
  permissions: Set<Permission>;
};

// A membership row as picked by the resolver, before permissions are layered.
type MembershipRow = {
  id: string;
  businessId: string;
  role: StoredRole;
  businessRoleId: string | null;
};

// Single source of truth for resolving a user's active business and what they
// may do in it. A user can belong to several businesses; the active one is the
// business their userActiveBusiness pointer names, provided they still hold a
// membership there. When the pointer is absent or stale (the business was left
// or deleted) it falls back to the oldest membership - deterministic, and the
// correct single-business default. The read path never writes, so a stale
// pointer is healed only when the user next switches (see setActiveBusiness).
export async function getActiveMembership(
  userId: string,
): Promise<ActiveMembership | null> {
  const db = getDb();
  const memberships = await db
    .select({
      id: schema.businessMember.id,
      businessId: schema.businessMember.businessId,
      role: schema.businessMember.role,
      businessRoleId: schema.businessMember.businessRoleId,
    })
    .from(schema.businessMember)
    .where(eq(schema.businessMember.userId, userId))
    .orderBy(asc(schema.businessMember.createdAt));

  if (memberships.length === 0) return null;

  const [pointer] = await db
    .select({ businessId: schema.userActiveBusiness.businessId })
    .from(schema.userActiveBusiness)
    .where(eq(schema.userActiveBusiness.userId, userId));

  const membership =
    (pointer &&
      memberships.find((m) => m.businessId === pointer.businessId)) ||
    memberships[0];

  return resolveMembership(db, membership);
}

// The user's membership in one named business, ignoring their active-business
// pointer. API keys resolve through this: a key is bound to the business it was
// made in, so switching businesses in the web app must not move it. Null when
// the user no longer belongs there, which stops the key working.
export async function getMembershipIn(
  userId: string,
  businessId: string,
): Promise<ActiveMembership | null> {
  const db = getDb();
  const [membership] = await db
    .select({
      id: schema.businessMember.id,
      businessId: schema.businessMember.businessId,
      role: schema.businessMember.role,
      businessRoleId: schema.businessMember.businessRoleId,
    })
    .from(schema.businessMember)
    .where(
      and(
        eq(schema.businessMember.userId, userId),
        eq(schema.businessMember.businessId, businessId),
      ),
    );
  return membership ? resolveMembership(db, membership) : null;
}

// Layers permissions onto a picked membership row. Split from the selection
// above so the active-business choice and the permission resolution stay
// independently testable.
async function resolveMembership(
  db: Db,
  membership: MembershipRow,
): Promise<ActiveMembership> {
  const base = {
    businessMemberId: membership.id,
    businessId: membership.businessId,
    role: membership.role,
    customRoleId: membership.businessRoleId,
  };

  // The owner wildcard is absolute: full permissions, overrides ignored.
  if (membership.role === "owner") {
    return {
      ...base,
      roleName: ROLE_META.owner.label,
      permissions: permissionsForRole("owner"),
    };
  }

  const overrideRows = await db
    .select({
      permission: schema.businessMemberPermission.permission,
      effect: schema.businessMemberPermission.effect,
    })
    .from(schema.businessMemberPermission)
    .where(eq(schema.businessMemberPermission.businessMemberId, membership.id));
  const overrides = overrideRows.filter((row) =>
    isPermission(row.permission),
  ) as { permission: Permission; effect: PermissionEffect }[];

  // Custom role: its permissions come from the business_role row.
  if (membership.role === "custom" && membership.businessRoleId) {
    const [customRole] = await db
      .select({
        name: schema.businessRole.name,
        permissions: schema.businessRole.permissions,
      })
      .from(schema.businessRole)
      .where(eq(schema.businessRole.id, membership.businessRoleId));
    const rolePerms = sanitizePermissions(
      (customRole?.permissions as string[]) ?? [],
    );
    return {
      ...base,
      roleName: customRole?.name ?? "Custom role",
      permissions: applyOverrides(new Set(rolePerms), overrides),
    };
  }

  // Predefined role. (A "custom" sentinel with no role id is treated as having
  // no base permissions - a safe default for inconsistent data.)
  const roleKey = isRole(membership.role) ? membership.role : null;
  const basePerms = roleKey ? permissionsForRole(roleKey) : new Set<Permission>();
  return {
    ...base,
    roleName: roleKey ? ROLE_META[roleKey].label : "No role",
    permissions: applyOverrides(basePerms, overrides),
  };
}

// One business the user can act in, for the switcher. roleName is the display
// label (predefined role label, or the custom role's name), and isActive marks
// the business getActiveMembership currently resolves to.
export type UserBusiness = {
  businessId: string;
  name: string;
  roleName: string;
  isActive: boolean;
};

// Every business the user belongs to, oldest membership first (the order the
// resolver falls back through). The active one is flagged so the caller does
// not have to re-run the resolution to know which is current.
export async function getUserBusinesses(
  userId: string,
): Promise<UserBusiness[]> {
  const db = getDb();
  const rows = await db
    .select({
      businessId: schema.business.id,
      name: schema.business.name,
      role: schema.businessMember.role,
      customRoleName: schema.businessRole.name,
    })
    .from(schema.businessMember)
    .innerJoin(
      schema.business,
      eq(schema.businessMember.businessId, schema.business.id),
    )
    .leftJoin(
      schema.businessRole,
      eq(schema.businessMember.businessRoleId, schema.businessRole.id),
    )
    .where(eq(schema.businessMember.userId, userId))
    .orderBy(asc(schema.businessMember.createdAt));

  if (rows.length === 0) return [];

  const [pointer] = await db
    .select({ businessId: schema.userActiveBusiness.businessId })
    .from(schema.userActiveBusiness)
    .where(eq(schema.userActiveBusiness.userId, userId));
  const activeId =
    (pointer && rows.some((r) => r.businessId === pointer.businessId)
      ? pointer.businessId
      : rows[0].businessId);

  return rows.map((row) => ({
    businessId: row.businessId,
    name: row.name,
    roleName:
      row.role === "custom"
        ? (row.customRoleName ?? "Custom role")
        : isRole(row.role)
          ? ROLE_META[row.role].label
          : "No role",
    isActive: row.businessId === activeId,
  }));
}

// Point the user's active business at `businessId`. Returns false (and writes
// nothing) when the user holds no membership there - the guard that stops a
// switch from granting access to a business the user was never part of. The
// pointer is upserted, so switching is idempotent and also heals a row that
// had gone stale.
export async function setActiveBusiness(
  userId: string,
  businessId: string,
): Promise<boolean> {
  const db = getDb();
  const [membership] = await db
    .select({ id: schema.businessMember.id })
    .from(schema.businessMember)
    .where(
      and(
        eq(schema.businessMember.userId, userId),
        eq(schema.businessMember.businessId, businessId),
      ),
    );
  if (!membership) return false;

  await db
    .insert(schema.userActiveBusiness)
    .values({ userId, businessId })
    .onConflictDoUpdate({
      target: schema.userActiveBusiness.userId,
      set: { businessId, updatedAt: new Date() },
    });
  return true;
}
