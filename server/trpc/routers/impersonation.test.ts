import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import type { Session } from "@/server/auth";
import { applyImpersonation } from "@/server/session";

import { createCallerFactory, type TRPCContext } from "../init";
import { appRouter } from "./_app";

// Support impersonation end to end through the real appRouter on PGlite: an
// admin starts viewing as a customer, every procedure then resolves to the
// customer, mutations are refused, and stop hands the session back.

const createCaller = createCallerFactory(appRouter);

let pglite: PGlite;
let db: Db;

const adminSession = {
  user: {
    id: "admin",
    name: "Support Admin",
    email: "admin@test.dev",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: { id: "admin-session-1", userId: "admin" },
} as unknown as Session;

// The context a browser request on the admin's session gets: built the way
// createTRPCContext does, through applyImpersonation.
async function adminRequestCtx(): Promise<TRPCContext> {
  const { impersonation, ...session } = await applyImpersonation(db, adminSession);
  return impersonation
    ? { headers: new Headers(), session, impersonation }
    : { headers: new Headers(), session };
}

async function adminCaller() {
  return createCaller(await adminRequestCtx());
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db.insert(schema.user).values([
    { id: "admin", name: "Support Admin", email: "admin@test.dev" },
    { id: "customer", name: "Customer Carla", email: "carla@test.dev" },
  ]);
  await db.insert(schema.platformAdmin).values({ userId: "admin" });
  const [biz] = await db
    .insert(schema.business)
    .values({ name: "Carla Studio", currency: "EUR" })
    .returning();
  await db
    .insert(schema.businessMember)
    .values({ businessId: biz.id, userId: "customer", role: "owner" });
  await db.insert(schema.client).values({ businessId: biz.id, name: "Carla's Client" });
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("support impersonation", () => {
  it("can only be started by a platform admin", async () => {
    const customer = createCaller({
      headers: new Headers(),
      session: { user: { id: "customer" }, session: { id: "c-sess" } } as unknown as Session,
    });
    await expect(
      customer.admin.startImpersonation({ userId: "admin", reason: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("needs a reason", async () => {
    const admin = await adminCaller();
    await expect(
      admin.admin.startImpersonation({ userId: "customer", reason: "  " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("can't stop what isn't running", async () => {
    const admin = await adminCaller();
    await expect(admin.impersonation.stop()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("views as the customer read-only, then hands the session back", async () => {
    await (await adminCaller()).admin.startImpersonation({
      userId: "customer",
      reason: "Ticket 7: can't find a client",
    });

    const ctx = await adminRequestCtx();
    expect(ctx.session?.user).toMatchObject({ id: "customer", name: "Customer Carla" });
    // The Better Auth session row stays the admin's own.
    expect(ctx.session?.session.id).toBe("admin-session-1");
    expect(ctx.impersonation).toMatchObject({ adminUserId: "admin", targetUserId: "customer" });

    const asCustomer = createCaller(ctx);
    // Reads see the customer's business.
    const clients = await asCustomer.clients.list({});
    expect(JSON.stringify(clients)).toContain("Carla's Client");

    // Every change is refused, whatever the permission.
    await expect(
      asCustomer.clients.create({ name: "Should not exist", contacts: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Read-only while viewing as another user" });
    await expect(asCustomer.business.create({ name: "Nope", currency: "EUR" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // No copies of their data.
    await expect(asCustomer.dataExport.everything()).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The customer isn't a platform admin, so neither is the view.
    await expect(asCustomer.admin.listUsers({})).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await asCustomer.impersonation.stop()).toEqual({ targetUserId: "customer" });

    const after = await adminRequestCtx();
    expect(after.session?.user.id).toBe("admin");
    expect(after.impersonation).toBeUndefined();

    const detail = await createCaller(after).admin.getUser({ userId: "customer" });
    expect(detail.impersonations).toHaveLength(1);
    expect(detail.impersonations[0]).toMatchObject({
      adminName: "Support Admin",
      reason: "Ticket 7: can't find a client",
      endedBy: "admin",
    });
    const clientRows = await db.select().from(schema.client);
    expect(clientRows.map((c) => c.name)).toEqual(["Carla's Client"]);
  });

  it("ignores an impersonation row whose admin doesn't own the session", async () => {
    await db.insert(schema.impersonation).values({
      adminUserId: "customer",
      adminSessionId: "admin-session-1",
      targetUserId: "admin",
      reason: "forged",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const ctx = await adminRequestCtx();
    expect(ctx.session?.user.id).toBe("admin");
    expect(ctx.impersonation).toBeUndefined();
  });
});
