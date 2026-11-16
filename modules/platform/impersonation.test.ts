import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import {
  endImpersonation,
  getActiveImpersonation,
  IMPERSONATION_TTL_MS,
  listImpersonationsOf,
  startImpersonation,
} from "./impersonation";

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.impersonation);
  await db.delete(schema.platformAdmin);
  await db.delete(schema.userSuspension);
  await db.delete(schema.user);
  await db.insert(schema.user).values([
    { id: "admin", name: "Support Admin", email: "admin@test.dev" },
    { id: "admin-2", name: "Other Admin", email: "admin-2@test.dev" },
    { id: "customer", name: "Customer", email: "customer@test.dev" },
    { id: "suspended", name: "Suspended", email: "suspended@test.dev" },
  ]);
  await db.insert(schema.platformAdmin).values([{ userId: "admin" }, { userId: "admin-2" }]);
  await db
    .insert(schema.userSuspension)
    .values({ userId: "suspended", suspendedAt: new Date() });
});

const t0 = new Date("2026-11-16T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function start(targetUserId: string, adminSessionId = "sess-1", now = t0) {
  return startImpersonation(db, {
    adminUserId: "admin",
    adminSessionId,
    targetUserId,
    reason: "Ticket 42: wrong invoice total",
    now,
  });
}

describe("startImpersonation", () => {
  it("refuses yourself, other admins, suspended and unknown accounts", async () => {
    expect(await start("admin")).toEqual({ ok: false, reason: "self" });
    expect(await start("admin-2")).toEqual({ ok: false, reason: "platform_admin" });
    expect(await start("suspended")).toEqual({ ok: false, reason: "suspended" });
    expect(await start("nobody")).toEqual({ ok: false, reason: "not_found" });
    expect(await db.select().from(schema.impersonation)).toHaveLength(0);
  });

  it("is live on that admin session only, until it expires", async () => {
    const result = await start("customer");
    expect(result.ok).toBe(true);

    const active = await getActiveImpersonation(db, "sess-1", at(1000));
    expect(active).toMatchObject({
      adminUserId: "admin",
      adminName: "Support Admin",
      targetUserId: "customer",
      reason: "Ticket 42: wrong invoice total",
      expiresAt: at(IMPERSONATION_TTL_MS),
    });
    expect(await getActiveImpersonation(db, "sess-other", at(1000))).toBeNull();
    expect(await getActiveImpersonation(db, "sess-1", at(IMPERSONATION_TTL_MS))).toBeNull();
  });

  it("ends an earlier impersonation still open on the same session", async () => {
    await start("customer");
    await db.insert(schema.user).values({ id: "c2", name: "C2", email: "c2@test.dev" });
    await start("c2", "sess-1", at(5000));

    const rows = await db.select().from(schema.impersonation);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.endedAt === null)).toHaveLength(1);
    expect((await getActiveImpersonation(db, "sess-1", at(6000)))?.targetUserId).toBe("c2");
  });
});

describe("endImpersonation", () => {
  it("only ends it from the session that started it", async () => {
    const result = await start("customer");
    if (!result.ok) throw new Error("expected a start");

    expect(await endImpersonation(db, result.impersonationId, "sess-other", at(1000))).toEqual({
      ok: false,
    });
    expect(await getActiveImpersonation(db, "sess-1", at(1000))).not.toBeNull();

    expect(await endImpersonation(db, result.impersonationId, "sess-1", at(2000))).toEqual({
      ok: true,
    });
    expect(await getActiveImpersonation(db, "sess-1", at(2001))).toBeNull();
    // Ending twice is a no-op, not a second end time.
    expect(await endImpersonation(db, result.impersonationId, "sess-1", at(3000))).toEqual({
      ok: false,
    });
  });
});

describe("listImpersonationsOf", () => {
  it("lists the history newest first, telling ended from expired and live", async () => {
    const first = await start("customer", "sess-1", t0);
    if (!first.ok) throw new Error("expected a start");
    await endImpersonation(db, first.impersonationId, "sess-1", at(60_000));
    await start("customer", "sess-2", at(120_000)); // left to expire
    const now = at(120_000 + IMPERSONATION_TTL_MS + 1);
    await start("customer", "sess-3", now); // live

    const history = await listImpersonationsOf(db, "customer", at(120_000 + IMPERSONATION_TTL_MS + 2));
    expect(history.map((h) => [h.endedBy, h.endedAt])).toEqual([
      [null, null],
      ["expired", at(120_000 + IMPERSONATION_TTL_MS)],
      ["admin", at(60_000)],
    ]);
    expect(history[0]).toMatchObject({ adminName: "Support Admin", reason: "Ticket 42: wrong invoice total" });
    expect(await listImpersonationsOf(db, "admin")).toEqual([]);
  });
});
