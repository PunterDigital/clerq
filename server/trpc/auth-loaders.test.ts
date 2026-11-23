import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { getActiveMembership } from "@/server/membership";
import {
  getBusinessSuspension,
  getUserSuspension,
} from "@/modules/platform/service";
import type { Session } from "@/server/auth";

import { contextFromSession, createCallerFactory, type AuthLoaders } from "./init";
import { appRouter } from "./routers/_app";

// The RSC caller hands the middleware request-scoped loaders (#5694), so a
// page's several tRPC calls share one set of suspension and membership
// reads. These tests pin that the middleware uses them when given and still
// enforces what they answer, and that a context without them (/api/trpc,
// MCP) reads the database on every call as before.

const createCaller = createCallerFactory(appRouter);

let pglite: PGlite;
let db: Db;
let businessId: string;

const session = {
  user: { id: "owner", name: "Owner", email: "owner@test.dev" },
  session: { id: "owner-session" },
} as unknown as Session;

function countingLoaders() {
  const calls = { userSuspension: 0, activeMembership: 0, businessSuspension: 0 };
  const memo = new Map<string, Promise<unknown>>();
  const once = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, load());
    return memo.get(key) as Promise<T>;
  };
  const loaders: AuthLoaders = {
    userSuspension: (userId) =>
      once(`u:${userId}`, () => {
        calls.userSuspension++;
        return getUserSuspension(db, userId);
      }),
    activeMembership: (userId) =>
      once(`m:${userId}`, () => {
        calls.activeMembership++;
        return getActiveMembership(userId);
      }),
    businessSuspension: (id) =>
      once(`b:${id}`, () => {
        calls.businessSuspension++;
        return getBusinessSuspension(db, id);
      }),
  };
  return { loaders, calls };
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@test.dev" });
  const [biz] = await db
    .insert(schema.business)
    .values({ name: "Owner Studio", currency: "EUR" })
    .returning();
  businessId = biz.id;
  await db
    .insert(schema.businessMember)
    .values({ businessId, userId: "owner", role: "owner" });
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("request-scoped auth loaders", () => {
  it("are used for every check, so several calls share one set of reads", async () => {
    const { loaders, calls } = countingLoaders();
    const caller = createCaller(contextFromSession(new Headers(), session, loaders));
    await Promise.all([
      caller.business.current(),
      caller.clients.list(),
      caller.business.list(),
    ]);
    await caller.projects.list({});
    expect(calls).toEqual({ userSuspension: 1, activeMembership: 1, businessSuspension: 1 });
  });

  it("still refuse a suspended account and a suspended business", async () => {
    await db.insert(schema.userSuspension).values({ userId: "owner", reason: "test", suspendedAt: new Date() });
    const first = countingLoaders();
    await expect(
      createCaller(contextFromSession(new Headers(), session, first.loaders)).clients.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.delete(schema.userSuspension);

    await db.insert(schema.businessSuspension).values({ businessId, reason: "test", suspendedAt: new Date() });
    const second = countingLoaders();
    await expect(
      createCaller(contextFromSession(new Headers(), session, second.loaders)).clients.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "This business has been suspended: test" });
    await db.delete(schema.businessSuspension);
  });

  it("are optional: without them each call reads the database (a new request sees a new suspension)", async () => {
    const caller = createCaller(contextFromSession(new Headers(), session));
    await expect(caller.clients.list()).resolves.toEqual([]);
    await db.insert(schema.userSuspension).values({ userId: "owner", reason: null, suspendedAt: new Date() });
    await expect(caller.clients.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.delete(schema.userSuspension);
  });

  it("builds an anonymous context without a session", () => {
    expect(contextFromSession(new Headers(), null).session).toBeNull();
  });
});
