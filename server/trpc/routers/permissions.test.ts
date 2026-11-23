import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import {
  PERMISSIONS,
  permissionsForRole,
  ROLES,
  type Permission,
  type Role,
} from "@/modules/authz";
import type { Session } from "@/server/auth";
import { createTestDatabase } from "@/db/testing";

import { createCallerFactory, type TRPCContext } from "../init";
import { appRouter } from "./_app";

// End-to-end authorization matrix. The real appRouter runs against in-process
// PGlite (via the getDb() test seam), so every assertion exercises the actual
// permissionProcedure gates - not a mock. For each predefined role we probe
// every permission's representative procedure and assert it is allowed exactly
// when the role grants it. Overrides and the role/permission management guards
// get their own sections below.

const createCaller = createCallerFactory(appRouter);
type Caller = ReturnType<typeof createCaller>;

function ctxFor(userId: string): TRPCContext {
  return {
    headers: new Headers(),
    session: { user: { id: userId }, session: {} } as unknown as Session,
  };
}

function callerFor(userId: string): Caller {
  return createCaller(ctxFor(userId));
}

// A call is "allowed" when it passes the permission gate: it either succeeds or
// fails for some non-authorization reason (NOT_FOUND, a foreign-key error from
// the random ids, etc). It is "denied" when the gate throws FORBIDDEN. Probes
// always use valid input, so a denied call can only ever fail with FORBIDDEN.
async function expectAllowed(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code;
    expect(code, `${label} should pass the permission gate`).not.toBe(
      "FORBIDDEN",
    );
  }
}

async function expectDenied(label: string, fn: () => Promise<unknown>) {
  await expect(fn(), label).rejects.toMatchObject({ code: "FORBIDDEN" });
}

// One representative procedure per permission, called with valid input.
const PROBES: Record<Permission, (c: Caller) => Promise<unknown>> = {
  "clients.view": (c) => c.clients.list({}),
  "clients.create": (c) => c.clients.create({ name: "Probe", contacts: [] }),
  "clients.edit": (c) =>
    c.clients.update({
      clientId: randomUUID(),
      data: { name: "Probe", contacts: [] },
    }),
  "clients.archive": (c) => c.clients.archive({ clientId: randomUUID() }),
  "clients.manageRates": (c) =>
    c.clients.setMemberRate({
      clientId: randomUUID(),
      data: { userId: "nobody", billRateMinor: 1000, billRateCurrency: "EUR" },
    }),
  "projects.view": (c) => c.projects.list({}),
  "projects.create": (c) =>
    c.projects.create({ name: "Probe", clientId: randomUUID() }),
  "projects.edit": (c) =>
    c.projects.update({
      projectId: randomUUID(),
      data: { name: "Probe", clientId: randomUUID() },
    }),
  "tasks.view": (c) => c.tasks.list({ projectId: randomUUID() }),
  "tasks.create": (c) =>
    c.tasks.create({ projectId: randomUUID(), data: { title: "Probe" } }),
  "tasks.edit": (c) =>
    c.tasks.update({ taskId: randomUUID(), data: { title: "Probe" } }),
  "tasks.delete": (c) => c.tasks.delete({ taskId: randomUUID() }),
  "time.log": (c) =>
    c.time.logManual({
      taskId: randomUUID(),
      startedAt: new Date(),
      durationSeconds: 60,
    }),
  "time.viewOwn": (c) => c.time.running(),
  "time.viewAll": (c) => c.time.listForTask({ taskId: randomUUID() }),
  "time.edit": (c) => c.time.updateNote({ entryId: randomUUID(), note: "x" }),
  "time.delete": (c) => c.time.deleteEntry({ entryId: randomUUID() }),
  "invoices.view": (c) => c.invoices.list(),
  "invoices.create": (c) =>
    c.invoices.createDraft({
      clientId: randomUUID(),
      currency: "EUR",
      taxTreatment: "zero_rated",
    }),
  "invoices.edit": (c) =>
    c.invoices.addLine({
      invoiceId: randomUUID(),
      description: "Probe",
      amountMajor: "10",
    }),
  "invoices.issue": (c) => c.invoices.issue({ invoiceId: randomUUID() }),
  "invoices.markPaid": (c) => c.invoices.markPaid({ invoiceId: randomUUID() }),
  "invoices.void": (c) => c.invoices.void({ invoiceId: randomUUID() }),
  "invoices.delete": (c) => c.invoices.delete({ invoiceId: randomUUID() }),
  "invoices.configure": (c) =>
    c.invoices.configureNextNumber({ year: 2026, nextNumber: 1 }),
  "invoices.manageRecurring": (c) =>
    c.recurring.create({
      clientId: randomUUID(),
      name: "Probe retainer",
      currency: "EUR",
      taxTreatment: "zero_rated",
      frequency: "monthly",
      interval: 1,
      startDate: new Date(),
      netTermsDays: 14,
      autoIssue: false,
      lines: [{ description: "Probe", amountMajor: "100" }],
    }),
  "expenses.view": (c) => c.expenses.list({}),
  "expenses.create": (c) =>
    c.expenses.create({
      description: "Probe",
      amountMinor: 100,
      currency: "EUR",
      incurredAt: new Date(),
    }),
  "expenses.edit": (c) =>
    c.expenses.update({
      expenseId: randomUUID(),
      data: {
        description: "Probe",
        amountMinor: 100,
        currency: "EUR",
        incurredAt: new Date(),
      },
    }),
  "expenses.approve": (c) =>
    c.expenses.setStatus({ expenseId: randomUUID(), status: "paid" }),
  "expenses.delete": (c) => c.expenses.delete({ expenseId: randomUUID() }),
  "expenses.manageTags": (c) =>
    c.expenses.tags.delete({ tagId: randomUUID() }),
  "dashboard.view": (c) => c.dashboard.summary(),
  "reports.viewProfit": (c) => c.reports.profit(),
  "team.view": (c) => c.team.list(),
  "team.invite": (c) =>
    c.team.invite({ email: `probe-${randomUUID()}@test.dev`, role: "member" }),
  "team.removeMember": (c) => c.team.removeMember({ userId: "nobody" }),
  "team.manageRoles": (c) =>
    c.team.setRole({ userId: "nobody", role: "member" }),
  "settings.view": (c) => c.business.settings(),
  "settings.edit": (c) =>
    c.business.updateSettings({
      name: "Probe",
      currency: "EUR",
      standardRatePct: null,
      vatNumber: null,
      address: null,
    }),
  "branding.edit": (c) =>
    c.business.updateBranding({
      logoDataUrl: null,
      brandColor: null,
      footerNote: null,
    }),
  "settings.manageUpdates": (c) =>
    c.system.setUpdateChecksEnabled({ enabled: true }),
  "data.export": (c) => c.dataExport.everything(),
  "apiKeys.manage": (c) => c.apiKeys.list(),
};

let pglite: PGlite;
let db: Db;

// Users keyed by the role they hold in their own (isolated) business.
const roleUser: Record<Role, string> = {} as Record<Role, string>;
// Override fixtures.
let viewerGrantee = ""; // viewer + grant clients.create
let memberDenied = ""; // member + deny invoices.issue
let ownerDenied = ""; // owner + deny settings.edit (must be ignored)

async function seedBusiness(label: string) {
  const [biz] = await db
    .insert(schema.business)
    .values({ name: label, currency: "EUR" })
    .returning();
  return biz;
}

async function addMember(
  businessId: string,
  userId: string,
  role: Role,
  email: string,
) {
  await db.insert(schema.user).values({ id: userId, name: userId, email });
  const [member] = await db
    .insert(schema.businessMember)
    .values({ businessId, userId, role })
    .returning();
  return member;
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  // A self-contained business per role: the owner plus, for non-owner roles,
  // the member under test.
  for (const role of ROLES) {
    const biz = await seedBusiness(`role-${role}`);
    await addMember(biz.id, `owner-of-${role}`, "owner", `owner-${role}@t.dev`);
    if (role === "owner") {
      roleUser[role] = `owner-of-${role}`;
    } else {
      roleUser[role] = `u-${role}`;
      await addMember(biz.id, roleUser[role], role, `${role}@t.dev`);
    }
  }

  // Override fixtures, each in its own business.
  const grantBiz = await seedBusiness("override-grant");
  await addMember(grantBiz.id, "og-owner", "owner", "og-owner@t.dev");
  viewerGrantee = "viewer-grantee";
  const grantee = await addMember(
    grantBiz.id,
    viewerGrantee,
    "viewer",
    "grantee@t.dev",
  );
  await db.insert(schema.businessMemberPermission).values({
    businessId: grantBiz.id,
    businessMemberId: grantee.id,
    permission: "clients.create",
    effect: "grant",
  });

  const denyBiz = await seedBusiness("override-deny");
  await addMember(denyBiz.id, "od-owner", "owner", "od-owner@t.dev");
  memberDenied = "member-denied";
  const denied = await addMember(
    denyBiz.id,
    memberDenied,
    "member",
    "denied@t.dev",
  );
  await db.insert(schema.businessMemberPermission).values({
    businessId: denyBiz.id,
    businessMemberId: denied.id,
    permission: "invoices.issue",
    effect: "deny",
  });

  const ownerBiz = await seedBusiness("override-owner");
  ownerDenied = "owner-denied";
  const od = await addMember(
    ownerBiz.id,
    ownerDenied,
    "owner",
    "owner-denied@t.dev",
  );
  await db.insert(schema.businessMemberPermission).values({
    businessId: ownerBiz.id,
    businessMemberId: od.id,
    permission: "settings.edit",
    effect: "deny",
  });
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("permission matrix (every role x every permission)", () => {
  for (const role of ROLES) {
    describe(`role: ${role}`, () => {
      const granted = permissionsForRole(role);
      for (const permission of PERMISSIONS) {
        const should = granted.has(permission);
        it(`${should ? "allows" : "denies"} ${permission}`, async () => {
          const caller = callerFor(roleUser[role]);
          const probe = () => PROBES[permission](caller);
          if (should) await expectAllowed(`${role}/${permission}`, probe);
          else await expectDenied(`${role}/${permission}`, probe);
        });
      }
    });
  }
});

describe("individual permission overrides", () => {
  it("a grant lets a viewer create clients", async () => {
    await expectAllowed("viewer+grant", () =>
      callerFor(viewerGrantee).clients.create({ name: "X", contacts: [] }),
    );
  });

  it("the grant does not leak to other permissions", async () => {
    await expectDenied("viewer+grant/edit", () =>
      callerFor(viewerGrantee).clients.update({
        clientId: randomUUID(),
        data: { name: "X", contacts: [] },
      }),
    );
  });

  it("a deny removes a permission the member's role would grant", async () => {
    await expectDenied("member+deny/issue", () =>
      callerFor(memberDenied).invoices.issue({ invoiceId: randomUUID() }),
    );
  });

  it("the deny leaves the rest of the role intact", async () => {
    await expectAllowed("member+deny/markPaid", () =>
      callerFor(memberDenied).invoices.markPaid({ invoiceId: randomUUID() }),
    );
  });

  it("an owner is never reduced by a deny override", async () => {
    await expectAllowed("owner+deny/settings", () =>
      callerFor(ownerDenied).business.updateSettings({
        name: "X",
        currency: "EUR",
        standardRatePct: null,
        vatNumber: null,
        address: null,
      }),
    );
  });
});

// The role and permission management guards. A dedicated business keeps these
// (some of which mutate) clear of the matrix fixtures above.
describe("role & permission management guards", () => {
  let bizId = "";
  const owner = "guard-owner";
  const admin = "guard-admin";
  const member = "guard-member";
  // A member granted manage-roles but who lacks settings.edit: the one way to
  // reach the "can't grant what you don't have" guard.
  const delegate = "guard-delegate";

  beforeAll(async () => {
    const biz = await seedBusiness("guards");
    bizId = biz.id;
    await addMember(bizId, owner, "owner", "g-owner@t.dev");
    await addMember(bizId, admin, "admin", "g-admin@t.dev");
    await addMember(bizId, member, "member", "g-member@t.dev");
    const del = await addMember(bizId, delegate, "member", "g-delegate@t.dev");
    await db.insert(schema.businessMemberPermission).values({
      businessId: bizId,
      businessMemberId: del.id,
      permission: "team.manageRoles",
      effect: "grant",
    });
  });

  it("an owner cannot change their own role", async () => {
    await expectDenied("self-role", () =>
      callerFor(owner).team.setRole({ userId: owner, role: "member" }),
    );
  });

  it("a non-owner cannot assign the owner role", async () => {
    await expectDenied("admin-assign-owner", () =>
      callerFor(admin).team.setRole({ userId: member, role: "owner" }),
    );
  });

  it("only an owner can change an existing owner's role", async () => {
    await expectDenied("admin-demote-owner", () =>
      callerFor(admin).team.setRole({ userId: owner, role: "member" }),
    );
  });

  it("an owner can change a normal member's role", async () => {
    const res = await callerFor(owner).team.setRole({
      userId: member,
      role: "manager",
    });
    expect(res).toEqual({ ok: true });
    // Put it back so other tests see the original role.
    await callerFor(owner).team.setRole({ userId: member, role: "member" });
  });

  it("cannot grant a permission the actor doesn't hold", async () => {
    await expectDenied("delegate-grant-beyond", () =>
      callerFor(delegate).team.setPermission({
        userId: member,
        permission: "settings.edit",
        effect: "grant",
      }),
    );
  });

  it("can always deny (de-escalate), even what the actor lacks", async () => {
    const res = await callerFor(delegate).team.setPermission({
      userId: member,
      permission: "settings.edit",
      effect: "deny",
    });
    expect(res).toEqual({ ok: true });
    await callerFor(delegate).team.setPermission({
      userId: member,
      permission: "settings.edit",
      effect: null,
    });
  });

  it("an owner's permissions cannot be overridden", async () => {
    await expectDenied("override-owner", () =>
      callerFor(admin).team.setPermission({
        userId: owner,
        permission: "settings.edit",
        effect: "deny",
      }),
    );
  });

  it("cannot manage your own permissions", async () => {
    await expectDenied("self-permission", () =>
      callerFor(admin).team.setPermission({
        userId: admin,
        permission: "settings.edit",
        effect: "deny",
      }),
    );
  });
});

// Custom, business-defined roles end to end: create, assign, enforce, layer
// overrides, and the management guards around them.
describe("custom roles (end-to-end)", () => {
  const owner = "cr-owner";
  const target = "cr-target";
  // A member granted manage-roles but lacking settings.edit, used to prove the
  // anti-escalation guard on role creation.
  const delegate = "cr-delegate";
  let roleId = "";

  beforeAll(async () => {
    const biz = await seedBusiness("custom-roles");
    await addMember(biz.id, owner, "owner", "cr-owner@t.dev");
    await addMember(biz.id, target, "member", "cr-target@t.dev");
    const del = await addMember(biz.id, delegate, "member", "cr-delegate@t.dev");
    await db.insert(schema.businessMemberPermission).values({
      businessId: biz.id,
      businessMemberId: del.id,
      permission: "team.manageRoles",
      effect: "grant",
    });

    // Owner creates a custom role and assigns it to the target member.
    const created = await callerFor(owner).team.createRole({
      name: "Limited",
      permissions: ["clients.view", "time.log"],
    });
    roleId = created.id;
    await callerFor(owner).team.setRole({ userId: target, role: roleId });
  });

  it("grants exactly the custom role's permissions", async () => {
    await expectAllowed("custom/clients.view", () =>
      callerFor(target).clients.list({}),
    );
    await expectAllowed("custom/time.log", () =>
      callerFor(target).time.logManual({
        taskId: randomUUID(),
        startedAt: new Date(),
        durationSeconds: 60,
      }),
    );
  });

  it("denies everything the custom role omits", async () => {
    await expectDenied("custom/clients.create", () =>
      callerFor(target).clients.create({ name: "X", contacts: [] }),
    );
    await expectDenied("custom/invoices.view", () =>
      callerFor(target).invoices.list(),
    );
    await expectDenied("custom/dashboard.view", () =>
      callerFor(target).dashboard.summary(),
    );
  });

  it("layers per-member overrides on top of a custom role", async () => {
    await callerFor(owner).team.setPermission({
      userId: target,
      permission: "dashboard.view",
      effect: "grant",
    });
    await expectAllowed("custom+grant/dashboard", () =>
      callerFor(target).dashboard.summary(),
    );
    // A deny on a permission the custom role grants removes it.
    await callerFor(owner).team.setPermission({
      userId: target,
      permission: "clients.view",
      effect: "deny",
    });
    await expectDenied("custom+deny/clients.view", () =>
      callerFor(target).clients.list({}),
    );
    // Reset overrides.
    await callerFor(owner).team.setPermission({
      userId: target,
      permission: "dashboard.view",
      effect: null,
    });
    await callerFor(owner).team.setPermission({
      userId: target,
      permission: "clients.view",
      effect: null,
    });
  });

  it("won't let a creator include a permission they don't hold", async () => {
    await expectDenied("escalate-create", () =>
      callerFor(delegate).team.createRole({
        name: "Sneaky",
        permissions: ["settings.edit"],
      }),
    );
  });

  it("lets a creator include permissions they do hold", async () => {
    const res = await callerFor(delegate).team.createRole({
      name: "Delegate Role",
      permissions: ["clients.view"],
    });
    expect(res.id).toBeTruthy();
  });

  it("blocks deleting a role that is still assigned", async () => {
    await expect(
      callerFor(owner).team.deleteRole({ roleId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("deletes once the role is no longer assigned", async () => {
    await callerFor(owner).team.setRole({ userId: target, role: "member" });
    const res = await callerFor(owner).team.deleteRole({ roleId });
    expect(res).toEqual({ ok: true });
  });

  it("won't let a non-owner reassign an owner to a custom role", async () => {
    const created = await callerFor(owner).team.createRole({
      name: "For Owner",
      permissions: ["clients.view"],
    });
    // delegate has team.manageRoles but is not an owner.
    await expect(
      callerFor(delegate).team.setRole({ userId: owner, role: created.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("can invite someone directly as a custom role", async () => {
    const made = await callerFor(owner).team.createRole({
      name: "Invitee Role",
      permissions: ["clients.view"],
    });
    const invitation = await callerFor(owner).team.invite({
      email: `cr-invitee-${randomUUID()}@test.dev`,
      role: made.id,
    });
    expect(invitation.role).toBe("custom");
    expect(invitation.businessRoleId).toBe(made.id);
  });
});

// #5582: inviting or setting a role is handing out its permissions, so a
// non-owner may only hand out a role whose permissions they all hold (the rule
// createRole and setPermission already used). Before, a manager could invite a
// second account as admin and get every permission, and a custom role with
// team.manageRoles could promote a colluding member above itself.
describe("role escalation guards (#5582)", () => {
  const owner = "esc-owner";
  const admin = "esc-admin";
  const manager = "esc-manager";
  const member = "esc-member";
  const adminTarget = "esc-admin-target";
  // A custom role holding team.manageRoles and a few other permissions.
  const delegate = "esc-delegate";
  let smallRoleId = "";
  let teamViewRoleId = "";
  let bigRoleId = "";

  const email = (tag: string) => `${tag}-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    const biz = await seedBusiness("escalation");
    await addMember(biz.id, owner, "owner", "esc-owner@t.dev");
    await addMember(biz.id, admin, "admin", "esc-admin@t.dev");
    await addMember(biz.id, manager, "manager", "esc-manager@t.dev");
    await addMember(biz.id, member, "member", "esc-member@t.dev");
    await addMember(biz.id, adminTarget, "admin", "esc-admin-target@t.dev");
    await addMember(biz.id, delegate, "member", "esc-delegate@t.dev");

    const delegateRole = await callerFor(owner).team.createRole({
      name: "Role manager",
      permissions: ["team.view", "team.manageRoles", "team.invite", "clients.view"],
    });
    await callerFor(owner).team.setRole({ userId: delegate, role: delegateRole.id });
    smallRoleId = (
      await callerFor(owner).team.createRole({
        name: "Clients only",
        permissions: ["clients.view"],
      })
    ).id;
    teamViewRoleId = (
      await callerFor(owner).team.createRole({
        name: "Clients and team",
        permissions: ["clients.view", "team.view"],
      })
    ).id;
    bigRoleId = (
      await callerFor(owner).team.createRole({
        name: "Keys and profit",
        permissions: ["clients.view", "apiKeys.manage", "reports.viewProfit"],
      })
    ).id;
  });

  it("refuses a manager inviting someone as admin", async () => {
    await expectDenied("manager-invite-admin", () =>
      callerFor(manager).team.invite({ email: email("m-admin"), role: "admin" }),
    );
  });

  it("refuses a manager inviting as a role with permissions they lack", async () => {
    await expectDenied("manager-invite-accountant", () =>
      callerFor(manager).team.invite({ email: email("m-acct"), role: "accountant" }),
    );
    await expectDenied("manager-invite-big-custom", () =>
      callerFor(manager).team.invite({ email: email("m-big"), role: bigRoleId }),
    );
  });

  it("still lets a manager invite as roles within their own set", async () => {
    const asMember = await callerFor(manager).team.invite({
      email: email("m-member"),
      role: "member",
    });
    expect(asMember.role).toBe("member");
    const asManager = await callerFor(manager).team.invite({
      email: email("m-manager"),
      role: "manager",
    });
    expect(asManager.role).toBe("manager");
    const asCustom = await callerFor(manager).team.invite({
      email: email("m-small"),
      role: smallRoleId,
    });
    expect(asCustom.businessRoleId).toBe(smallRoleId);
  });

  it("lets an admin invite someone as admin", async () => {
    const invitation = await callerFor(admin).team.invite({
      email: email("a-admin"),
      role: "admin",
    });
    expect(invitation.role).toBe("admin");
  });

  it("refuses an admin with a deny override inviting a full admin", async () => {
    const [row] = await db
      .select({
        id: schema.businessMember.id,
        businessId: schema.businessMember.businessId,
      })
      .from(schema.businessMember)
      .where(eq(schema.businessMember.userId, admin));
    await db.insert(schema.businessMemberPermission).values({
      businessId: row.businessId,
      businessMemberId: row.id,
      permission: "apiKeys.manage",
      effect: "deny",
    });
    try {
      await expectDenied("denied-admin-invite-admin", () =>
        callerFor(admin).team.invite({ email: email("da-admin"), role: "admin" }),
      );
    } finally {
      await db
        .delete(schema.businessMemberPermission)
        .where(eq(schema.businessMemberPermission.businessMemberId, row.id));
    }
  });

  it("refuses a custom-role holder promoting someone above their own set", async () => {
    // Start the target inside the delegate's set, so only the new role counts.
    await callerFor(owner).team.setRole({ userId: member, role: smallRoleId });
    try {
      await expectDenied("delegate-promote-admin", () =>
        callerFor(delegate).team.setRole({ userId: member, role: "admin" }),
      );
      await expectDenied("delegate-promote-big-custom", () =>
        callerFor(delegate).team.setRole({ userId: member, role: bigRoleId }),
      );
      await expectDenied("delegate-invite-admin", () =>
        callerFor(delegate).team.invite({ email: email("d-admin"), role: "admin" }),
      );
    } finally {
      await callerFor(owner).team.setRole({ userId: member, role: "member" });
    }
  });

  it("lets a custom-role holder move someone within their own set", async () => {
    await callerFor(owner).team.setRole({ userId: member, role: smallRoleId });
    try {
      const res = await callerFor(delegate).team.setRole({
        userId: member,
        role: teamViewRoleId,
      });
      expect(res).toEqual({ ok: true });
    } finally {
      await callerFor(owner).team.setRole({ userId: member, role: "member" });
    }
  });

  it("refuses changing the role of someone who holds permissions the actor lacks", async () => {
    // A member (and an admin) hold far more than the delegate's custom role,
    // so even a demotion to a role the delegate may hand out is refused.
    await expectDenied("delegate-demote-member", () =>
      callerFor(delegate).team.setRole({ userId: member, role: smallRoleId }),
    );
    await expectDenied("delegate-demote-admin", () =>
      callerFor(delegate).team.setRole({ userId: adminTarget, role: smallRoleId }),
    );
  });

  it("lets an admin change another admin's role, and an owner anyone's", async () => {
    expect(
      await callerFor(admin).team.setRole({ userId: adminTarget, role: "manager" }),
    ).toEqual({ ok: true });
    expect(
      await callerFor(owner).team.setRole({ userId: adminTarget, role: "admin" }),
    ).toEqual({ ok: true });
  });

  it("offers only the roles and members the actor may hand out or change", async () => {
    const asManager = await callerFor(manager).team.list();
    expect(asManager.assignableRoles).toEqual([
      "manager",
      "member",
      "contractor",
      "viewer",
    ]);
    expect(asManager.assignableCustomRoleIds).toContain(smallRoleId);
    expect(asManager.assignableCustomRoleIds).not.toContain(bigRoleId);
    // A manager has no team.manageRoles, so no role pickers on member rows.
    expect(asManager.roleEditableUserIds).toEqual([]);

    const asDelegate = await callerFor(delegate).team.list();
    expect(asDelegate.assignableRoles).toEqual([]);
    expect(asDelegate.assignableCustomRoleIds).toEqual(
      expect.arrayContaining([smallRoleId, teamViewRoleId]),
    );
    expect(asDelegate.assignableCustomRoleIds).not.toContain(bigRoleId);
    for (const userId of [owner, admin, adminTarget, member, delegate]) {
      expect(asDelegate.roleEditableUserIds).not.toContain(userId);
    }

    const asAdmin = await callerFor(admin).team.list();
    expect(asAdmin.assignableRoles).toContain("admin");
    expect(asAdmin.assignableRoles).not.toContain("owner");
    expect(asAdmin.roleEditableUserIds).toContain(adminTarget);
    expect(asAdmin.roleEditableUserIds).toContain(delegate);
    expect(asAdmin.roleEditableUserIds).not.toContain(owner);
    expect(asAdmin.roleEditableUserIds).not.toContain(admin);

    const asOwner = await callerFor(owner).team.list();
    expect(asOwner.assignableRoles).toContain("owner");
    expect(asOwner.assignableCustomRoleIds).toContain(bigRoleId);
  });
});
