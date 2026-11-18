import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import type { Session } from "@/server/auth";
import { createTestDatabase } from "@/db/testing";

import { createCallerFactory, type TRPCContext } from "../init";
import { appRouter } from "./_app";

// Multi-business per account (the "organization switcher"): one user, several
// businesses, switching between them and the isolation that stops a switch from
// reaching a business the user never joined. The real appRouter runs against
// in-process PGlite via the getDb() test seam, so every assertion exercises the
// actual procedures and the membership resolver - not mocks.

const createCaller = createCallerFactory(appRouter);
type Caller = ReturnType<typeof createCaller>;

function callerFor(userId: string): Caller {
  const ctx: TRPCContext = {
    headers: new Headers(),
    session: { user: { id: userId }, session: {} } as unknown as Session,
  };
  return createCaller(ctx);
}

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

// A clean slate per test: the resolver depends on membership order and the
// active pointer, both of which earlier tests mutate.
beforeEach(async () => {
  await db.delete(schema.userActiveBusiness);
  await db.delete(schema.businessMember);
  await db.delete(schema.business);
  await db.delete(schema.user);
  await db.insert(schema.user).values([
    { id: "shay", name: "Shay", email: "shay@test.dev" },
    { id: "other", name: "Other", email: "other@test.dev" },
  ]);
});

describe("multiple businesses per account", () => {
  it("creates a second business and makes it active", async () => {
    const caller = callerFor("shay");
    const first = await caller.business.create({ name: "Alpha", currency: "GBP" });
    expect((await caller.business.current()).id).toBe(first.id);

    const second = await caller.business.create({ name: "Beta", currency: "EUR" });
    // Creating switches to the new one - no hunting for it afterwards.
    expect((await caller.business.current()).id).toBe(second.id);
  });

  it("lists every business the user belongs to, flagging the active one", async () => {
    const caller = callerFor("shay");
    const alpha = await caller.business.create({ name: "Alpha", currency: "GBP" });
    const beta = await caller.business.create({ name: "Beta", currency: "EUR" });

    const list = await caller.business.list();
    expect(list.map((b) => b.name)).toEqual(["Alpha", "Beta"]);
    expect(list.every((b) => b.roleName === "Owner")).toBe(true);
    const active = list.filter((b) => b.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].businessId).toBe(beta.id);
    expect(alpha.id).not.toBe(beta.id);
  });

  it("switches the active business and scopes reads to it", async () => {
    const caller = callerFor("shay");
    const alpha = await caller.business.create({ name: "Alpha", currency: "GBP" });
    await caller.business.create({ name: "Beta", currency: "EUR" });

    const result = await caller.business.switch({ businessId: alpha.id });
    expect(result.businessId).toBe(alpha.id);

    expect((await caller.business.current()).id).toBe(alpha.id);
    expect(
      (await caller.business.list()).find((b) => b.isActive)?.businessId,
    ).toBe(alpha.id);
  });

  it("isolates businesses: a user cannot switch into one they never joined", async () => {
    const shay = callerFor("shay");
    const alpha = await shay.business.create({ name: "Alpha", currency: "GBP" });

    const stranger = callerFor("other");
    await stranger.business.create({ name: "Strangers Co", currency: "USD" });

    await expect(
      stranger.business.switch({ businessId: alpha.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The stranger's active business is untouched by the rejected switch.
    expect((await stranger.business.current()).name).toBe("Strangers Co");
  });

  it("falls back to the oldest membership when the active pointer is stale", async () => {
    const caller = callerFor("shay");
    const alpha = await caller.business.create({ name: "Alpha", currency: "GBP" });
    const beta = await caller.business.create({ name: "Beta", currency: "EUR" });
    expect((await caller.business.current()).id).toBe(beta.id);

    // The user leaves Beta (their active business) entirely.
    await db
      .delete(schema.businessMember)
      .where(eq(schema.businessMember.businessId, beta.id));

    // Resolution must not strand them on the now-inaccessible Beta; it falls
    // back to the oldest remaining membership.
    expect((await caller.business.current()).id).toBe(alpha.id);
    const list = await caller.business.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ businessId: alpha.id, isActive: true });
  });
});

describe("business settings - structured postal address", () => {
  it("saves, returns, keeps when left out, and clears it", async () => {
    const caller = callerFor("shay");
    await caller.business.create({ name: "Alpha", currency: "GBP" });
    const base = {
      name: "Alpha",
      currency: "GBP",
      hoursPerDay: 8,
      standardRatePct: null,
      vatNumber: null,
      address: "10115 Berlin",
    };

    await caller.business.updateSettings({
      ...base,
      postalAddress: { street: "Hauptstraße 5", city: "Berlin", postcode: "10115", country: "de" },
    });
    expect((await caller.business.settings()).postalAddress).toEqual({
      street: "Hauptstraße 5",
      city: "Berlin",
      postcode: "10115",
      region: null,
      country: "DE",
    });

    await caller.business.updateSettings(base);
    expect((await caller.business.settings()).postalAddress?.country).toBe("DE");

    await caller.business.updateSettings({ ...base, postalAddress: null });
    expect((await caller.business.settings()).postalAddress).toBeNull();
  });

  it("refuses an unknown country code", async () => {
    const caller = callerFor("shay");
    await caller.business.create({ name: "Alpha", currency: "GBP" });
    await expect(
      caller.business.updateSettings({
        name: "Alpha",
        currency: "GBP",
        hoursPerDay: 8,
        standardRatePct: null,
        vatNumber: null,
        address: null,
        postalAddress: { city: "Nowhere", country: "XX" },
      }),
    ).rejects.toThrow(/country/i);
  });
});
