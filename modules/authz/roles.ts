// Which permissions each predefined role grants. `owner` is a wildcard - it
// always holds every permission and is never reduced. The other roles are
// explicit subsets, kept here so the whole privilege ladder reads top to
// bottom in one place. The permission matrix test asserts every entry is a
// real permission and that the ladder stays consistent (e.g. admin >= member).

import {
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
  type StoredRole,
} from "./permissions";

// Operational building blocks, composed into roles below.
const CLIENTS_FULL = [
  "clients.view",
  "clients.create",
  "clients.edit",
  "clients.archive",
  "clients.manageRates",
] satisfies Permission[];

const PROJECTS_FULL = [
  "projects.view",
  "projects.create",
  "projects.edit",
] satisfies Permission[];

const TASKS_FULL = [
  "tasks.view",
  "tasks.create",
  "tasks.edit",
  "tasks.delete",
] satisfies Permission[];

const TIME_FULL = [
  "time.log",
  "time.viewOwn",
  "time.viewAll",
  "time.edit",
  "time.delete",
] satisfies Permission[];

// Operational invoice work, excluding numbering configuration.
const INVOICES_OPS = [
  "invoices.view",
  "invoices.create",
  "invoices.edit",
  "invoices.issue",
  "invoices.markPaid",
  "invoices.void",
  "invoices.delete",
  "invoices.manageRecurring",
] satisfies Permission[];

const EXPENSES_FULL = [
  "expenses.view",
  "expenses.create",
  "expenses.edit",
  "expenses.approve",
  "expenses.delete",
] satisfies Permission[];

// The full operational surface: everything a member can do today. Mapping the
// legacy `member` role to exactly this set keeps existing members' abilities
// unchanged when roles ship (see db migration 0012).
const MEMBER_PERMISSIONS = [
  ...CLIENTS_FULL,
  ...PROJECTS_FULL,
  ...TASKS_FULL,
  ...TIME_FULL,
  ...INVOICES_OPS,
  ...EXPENSES_FULL,
  "dashboard.view",
  "settings.view",
  "team.view",
] satisfies Permission[];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Wildcard: kept in sync with the catalog automatically.
  owner: [...PERMISSIONS],
  // Everything except the owner-only ownership concerns; admins manage roles,
  // settings, branding and numbering.
  admin: [...PERMISSIONS],
  // Delivery lead: full operational access plus team roster management.
  manager: [...MEMBER_PERMISSIONS, "team.invite", "team.removeMember"],
  // The behaviour-preserving default for existing members.
  member: [...MEMBER_PERMISSIONS],
  // Finance: full invoices (incl. numbering) and expenses, read elsewhere.
  accountant: [
    "clients.view",
    "projects.view",
    "tasks.view",
    "time.viewOwn",
    "time.viewAll",
    ...INVOICES_OPS,
    "invoices.configure",
    ...EXPENSES_FULL,
    "dashboard.view",
    // Finance owns the P&L view (income, expenses, what the business pays out).
    "reports.viewProfit",
    "settings.view",
    "team.view",
  ],
  // External: log time against assigned work, see only their own time.
  contractor: [
    "projects.view",
    "tasks.view",
    "time.log",
    "time.viewOwn",
    "dashboard.view",
  ],
  // Read-only across the workspace.
  viewer: [
    "clients.view",
    "projects.view",
    "tasks.view",
    "time.viewOwn",
    "invoices.view",
    "expenses.view",
    "dashboard.view",
    "team.view",
  ],
};

// admin differs from owner only in the ownership invariants enforced by the
// team service, not in the permission set - both hold the full catalog.

export function permissionsForRole(role: Role): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

// The anti-escalation rule for handing out access: a non-owner may only give
// someone a set of permissions they hold every one of themselves. Granting an
// override, building a custom role, inviting as a role and setting a role all
// go through this, so nobody can mint a role above their own (#5582). An owner
// holds everything, so this always passes for them.
export function holdsAll(
  actorPermissions: ReadonlySet<Permission>,
  permissions: Iterable<Permission>,
): boolean {
  for (const permission of permissions) {
    if (!actorPermissions.has(permission)) return false;
  }
  return true;
}

// Predefined roles a member may assign (invite as, or set). Only an owner may
// make another owner. Everyone else may assign a role only when they hold all
// of its permissions themselves (`holdsAll`), so a manager can't hand out admin
// and an admin with a deny override can't hand out a full admin either. A
// business's custom roles go through the same `holdsAll` check in the router.
export function assignableRoles(
  actorRole: StoredRole,
  actorPermissions: ReadonlySet<Permission>,
): Role[] {
  if (actorRole === "owner") return [...ROLES];
  return ROLES.filter(
    (role) => role !== "owner" && holdsAll(actorPermissions, ROLE_PERMISSIONS[role]),
  );
}

