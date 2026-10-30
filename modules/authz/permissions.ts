// The authorization catalog: the single source of truth for what actions
// exist (permissions), how they group for display, and which predefined
// roles bundle them. Enforcement reads from here (server/trpc/init.ts), the
// settings UI renders from here, and the docs are generated from here - so a
// permission only ever exists in one place.
//
// A permission is a `resource.action` string. Every permission listed here is
// wired to at least one tRPC procedure and covered by the permission matrix
// test (server/trpc/routers/permissions.test.ts); adding one without a gate
// (or a gate without a permission) fails that test.

export const PERMISSIONS = [
  // Clients
  "clients.view",
  "clients.create",
  "clients.edit",
  "clients.archive",
  "clients.manageRates",
  // Projects
  "projects.view",
  "projects.create",
  "projects.edit",
  // Tasks
  "tasks.view",
  "tasks.create",
  "tasks.edit",
  "tasks.delete",
  // Time
  "time.log",
  "time.viewOwn",
  "time.viewAll",
  "time.edit",
  "time.delete",
  // Invoices
  "invoices.view",
  "invoices.create",
  "invoices.edit",
  "invoices.issue",
  "invoices.markPaid",
  "invoices.void",
  "invoices.delete",
  "invoices.configure",
  "invoices.manageRecurring",
  // Expenses
  "expenses.view",
  "expenses.create",
  "expenses.edit",
  "expenses.approve",
  "expenses.delete",
  // Insights
  "dashboard.view",
  // Reports
  "reports.viewProfit",
  // Team
  "team.view",
  "team.invite",
  "team.removeMember",
  "team.manageRoles",
  // Settings
  "settings.view",
  "settings.edit",
  "branding.edit",
  "settings.manageUpdates",
  // Exporting a full, portable copy of the business's data is a high-trust
  // action (it dumps financials, receipts, internal costs and the team roster
  // in one file), so it is its own permission rather than folded into
  // settings.view - only owners and admins hold it by default.
  "data.export",
  // An API key acts as its creator for anyone who holds it, outside the
  // browser, so minting and revoking keys is owner/admin by default.
  "apiKeys.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value as Permission);
}

// Display grouping for the permissions matrix in settings. Order here is the
// order rendered.
export const PERMISSION_GROUPS = [
  "Clients",
  "Projects",
  "Tasks",
  "Time",
  "Invoices",
  "Expenses",
  "Insights",
  "Reports",
  "Team",
  "Settings",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSION_META: Record<
  Permission,
  { group: PermissionGroup; label: string; description: string }
> = {
  "clients.view": {
    group: "Clients",
    label: "View clients",
    description: "See the client list, client details and activity.",
  },
  "clients.create": {
    group: "Clients",
    label: "Create clients",
    description: "Add new clients and import them in bulk.",
  },
  "clients.edit": {
    group: "Clients",
    label: "Edit clients",
    description: "Change client details and add notes.",
  },
  "clients.archive": {
    group: "Clients",
    label: "Archive clients",
    description: "Archive and restore clients.",
  },
  "clients.manageRates": {
    group: "Clients",
    label: "Manage client rates",
    description:
      "Set the client's default rate, budgets and per-member bill rates.",
  },
  "projects.view": {
    group: "Projects",
    label: "View projects",
    description: "See projects and their details.",
  },
  "projects.create": {
    group: "Projects",
    label: "Create projects",
    description: "Start new projects.",
  },
  "projects.edit": {
    group: "Projects",
    label: "Edit projects",
    description: "Change project details, status and rates.",
  },
  "tasks.view": {
    group: "Tasks",
    label: "View tasks",
    description: "See the tasks on a project.",
  },
  "tasks.create": {
    group: "Tasks",
    label: "Create tasks",
    description: "Add tasks to a project.",
  },
  "tasks.edit": {
    group: "Tasks",
    label: "Edit tasks",
    description: "Change task details and move them between statuses.",
  },
  "tasks.delete": {
    group: "Tasks",
    label: "Delete tasks",
    description: "Remove tasks from a project.",
  },
  "time.log": {
    group: "Time",
    label: "Log time",
    description: "Start and stop the timer and add manual time entries.",
  },
  "time.viewOwn": {
    group: "Time",
    label: "View own time",
    description: "See your own timesheet and running timer.",
  },
  "time.viewAll": {
    group: "Time",
    label: "View everyone's time",
    description: "See time entries logged by other team members.",
  },
  "time.edit": {
    group: "Time",
    label: "Edit time",
    description: "Change the notes on time entries.",
  },
  "time.delete": {
    group: "Time",
    label: "Delete time",
    description: "Remove time entries.",
  },
  "invoices.view": {
    group: "Invoices",
    label: "View invoices",
    description: "See invoices and look up exchange rates.",
  },
  "invoices.create": {
    group: "Invoices",
    label: "Create invoices",
    description: "Create draft invoices.",
  },
  "invoices.edit": {
    group: "Invoices",
    label: "Edit invoices",
    description: "Add and remove lines and generate lines from time.",
  },
  "invoices.issue": {
    group: "Invoices",
    label: "Issue invoices",
    description: "Issue a draft, assigning its number.",
  },
  "invoices.markPaid": {
    group: "Invoices",
    label: "Mark invoices paid",
    description: "Record an invoice as paid.",
  },
  "invoices.void": {
    group: "Invoices",
    label: "Void invoices",
    description: "Void an issued invoice so a corrected copy can be re-issued.",
  },
  "invoices.delete": {
    group: "Invoices",
    label: "Delete draft invoices",
    description: "Delete a draft invoice (issued invoices are kept).",
  },
  "invoices.configure": {
    group: "Invoices",
    label: "Configure numbering",
    description: "Change the next invoice number for a year.",
  },
  "invoices.manageRecurring": {
    group: "Invoices",
    label: "Manage recurring invoices",
    description:
      "Create, edit, pause and end recurring invoices (retainers) that generate invoices on a schedule.",
  },
  "expenses.view": {
    group: "Expenses",
    label: "View expenses",
    description: "See the expense list and receipts.",
  },
  "expenses.create": {
    group: "Expenses",
    label: "Create expenses",
    description: "Record new expenses.",
  },
  "expenses.edit": {
    group: "Expenses",
    label: "Edit expenses",
    description: "Change the details of an expense.",
  },
  "expenses.approve": {
    group: "Expenses",
    label: "Approve expenses",
    description: "Mark expenses paid or unpaid.",
  },
  "expenses.delete": {
    group: "Expenses",
    label: "Delete expenses",
    description: "Remove expenses.",
  },
  "dashboard.view": {
    group: "Insights",
    label: "View dashboard",
    description: "See the business dashboard and its financial summary.",
  },
  "reports.viewProfit": {
    group: "Reports",
    label: "View profit & costs",
    description:
      "See the profit report and team internal costs (what the business pays its members).",
  },
  "team.view": {
    group: "Team",
    label: "View team",
    description: "See who is on the team.",
  },
  "team.invite": {
    group: "Team",
    label: "Invite members",
    description: "Invite people and revoke pending invitations.",
  },
  "team.removeMember": {
    group: "Team",
    label: "Remove members",
    description: "Remove people from the team.",
  },
  "team.manageRoles": {
    group: "Team",
    label: "Manage roles & permissions",
    description: "Change members' roles and individual permissions.",
  },
  "settings.view": {
    group: "Settings",
    label: "View settings",
    description: "See the business settings.",
  },
  "settings.edit": {
    group: "Settings",
    label: "Edit settings",
    description: "Change the business name, address, currency and tax.",
  },
  "branding.edit": {
    group: "Settings",
    label: "Edit branding",
    description: "Change the logo, brand colour and invoice footer.",
  },
  "settings.manageUpdates": {
    group: "Settings",
    label: "Manage update checks",
    description:
      "See and dismiss available-update prompts, and turn checking for new Clerq versions on or off.",
  },
  "data.export": {
    group: "Settings",
    label: "Export all data",
    description:
      "Download a complete, portable copy of the business's data - clients, projects, tasks, time, invoices, expenses, team and settings.",
  },
  "apiKeys.manage": {
    group: "Settings",
    label: "Manage API keys",
    description:
      "Create and revoke API keys that let scripts and other apps use the Clerq API as you.",
  },
};

// The predefined roles, ordered most to least privileged. `owner` is special:
// it always holds every permission (a wildcard, see roles.ts) and carries the
// ownership invariants enforced in the team service (a business always keeps
// at least one owner; only an owner may grant the owner role).
export const ROLES = [
  "owner",
  "admin",
  "manager",
  "member",
  "accountant",
  "contractor",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_SET: ReadonlySet<Role> = new Set(ROLES);

export function isRole(value: string): value is Role {
  return ROLE_SET.has(value as Role);
}

// The sentinel stored in business_member.role when a member holds a custom,
// business-defined role (its permissions live in the business_role row that
// business_role_id points at, not in the predefined catalog).
export const CUSTOM_ROLE = "custom" as const;

// What the business_member.role column can hold: a predefined role or the
// custom sentinel.
export type StoredRole = Role | typeof CUSTOM_ROLE;

export const ROLE_META: Record<
  Role,
  { label: string; description: string }
> = {
  owner: {
    label: "Owner",
    description:
      "Full control of the business, including billing and ownership. There is always at least one owner.",
  },
  admin: {
    label: "Admin",
    description:
      "Runs the workspace day to day: everything an owner can do except transferring ownership.",
  },
  manager: {
    label: "Manager",
    description:
      "Leads delivery: full operational access plus inviting and removing teammates. Can't change settings or roles.",
  },
  member: {
    label: "Member",
    description:
      "Does the work: manage clients, projects, tasks, time, invoices and expenses. No team or settings management.",
  },
  accountant: {
    label: "Accountant",
    description:
      "Finance focused: full invoices and expenses, read-only everywhere else.",
  },
  contractor: {
    label: "Contractor",
    description:
      "External collaborator: log time against projects and tasks, see their own time only.",
  },
  viewer: {
    label: "Viewer",
    description: "Read-only access across the workspace.",
  },
};
