import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import type { Session } from "@/server/auth";

import {
  API_KEY_PREFIX,
  createApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "./api-keys";
import {
  ApiError,
  errorResponse,
  paginate,
  RATE_LIMIT_PER_MINUTE,
  resetRateLimits,
  takeRateLimit,
} from "./api/v1";
import { createClerqCaller, mcpContextForUser } from "./mcp/caller";
import { TRPCError } from "@trpc/server";

// API keys end to end against in-process Postgres (PGlite via the getDb()
// seam): storage, verification, the tRPC scope/business pinning, and the
// /api/v1 and /api/mcp route handlers.

let pglite: PGlite;
let db: Db;

// "alice" owns business A and business B, and her active business is B: a key
// she makes in A must still act in A. "bob" is a viewer in A.
let bizA = "";
let bizB = "";

async function seedBusiness(name: string) {
  const [biz] = await db
    .insert(schema.business)
    .values({ name, currency: "EUR" })
    .returning();
  return biz.id;
}

async function addUser(id: string) {
  await db.insert(schema.user).values({ id, name: id, email: `${id}@t.dev` });
}

function sessionCaller(userId: string) {
  return createClerqCaller({
    headers: new Headers(),
    session: { user: { id: userId }, session: {} } as unknown as Session,
  });
}

function keyCaller(
  key: { id: string; businessId: string; scope: "read" | "write" },
  userId = "alice",
) {
  return createClerqCaller(mcpContextForUser(userId, new Headers(), key));
}

function get(path: string, key?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-api-keys";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await addUser("alice");
  await addUser("bob");
  bizA = await seedBusiness("Business A");
  bizB = await seedBusiness("Business B");
  await db.insert(schema.businessMember).values([
    { businessId: bizA, userId: "alice", role: "owner" },
    { businessId: bizB, userId: "alice", role: "owner" },
    { businessId: bizA, userId: "bob", role: "viewer" },
  ]);
  await db
    .insert(schema.userActiveBusiness)
    .values({ userId: "alice", businessId: bizB });

  await sessionCaller("alice").business.switch({ businessId: bizA });
  await sessionCaller("alice").clients.create({ name: "Client of A", contacts: [] });
  await sessionCaller("alice").business.switch({ businessId: bizB });
  await sessionCaller("alice").clients.create({ name: "Client of B", contacts: [] });
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(() => resetRateLimits());

describe("storage", () => {
  it("stores only the SHA-256 of the key, never the key itself", async () => {
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "storage",
      scope: "read",
    });
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(40);

    const [row] = await db
      .select()
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, id));
    expect(row.keyHash).toBe(hashApiKey(key));
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.keyPrefix).toBe(key.slice(0, 12));
    for (const value of Object.values(row)) {
      expect(value).not.toBe(key);
    }
  });

  it("makes a different key every time", async () => {
    const input = { businessId: bizA, userId: "alice", name: "x", scope: "read" as const };
    const a = await createApiKey(db, input);
    const b = await createApiKey(db, input);
    expect(a.key).not.toBe(b.key);
  });
});

describe("verification", () => {
  it("resolves a live key to its business, creator and scope, and records the use", async () => {
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "verify",
      scope: "write",
    });
    const verified = await verifyApiKey(db, key);
    expect(verified).toMatchObject({
      id,
      businessId: bizA,
      userId: "alice",
      scope: "write",
    });
    const [row] = await db
      .select({ lastUsedAt: schema.apiKey.lastUsedAt })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, id));
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it("refuses unknown, malformed and revoked keys", async () => {
    expect(await verifyApiKey(db, `${API_KEY_PREFIX}not-a-real-key`)).toBeNull();
    expect(await verifyApiKey(db, "some-oauth-token")).toBeNull();

    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "revoked",
      scope: "read",
    });
    expect(await revokeApiKey(db, bizA, id)).toBe(true);
    expect(await verifyApiKey(db, key)).toBeNull();
    // Revoking twice, or from another business, finds nothing.
    expect(await revokeApiKey(db, bizA, id)).toBe(false);
  });

  it("can't be revoked from another business", async () => {
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "cross-revoke",
      scope: "read",
    });
    expect(await revokeApiKey(db, bizB, id)).toBe(false);
    expect(await verifyApiKey(db, key)).not.toBeNull();
  });
});

describe("tRPC with an API key", () => {
  it("acts in the key's business, not the creator's active business", async () => {
    // alice's active business is B; the key was made in A.
    const caller = keyCaller({ id: "k", businessId: bizA, scope: "read" });
    const clients = await caller.clients.list({});
    const names = clients.map((c: { name: string }) => c.name);
    expect(names).toContain("Client of A");
    expect(names).not.toContain("Client of B");
    expect((await caller.business.current()).id).toBe(bizA);
  });

  it("a read-only key can read but not write (403)", async () => {
    const caller = keyCaller({ id: "k", businessId: bizA, scope: "read" });
    await expect(
      caller.clients.create({ name: "Nope", contacts: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "This API key is read-only" });
  });

  it("a read-write key can write", async () => {
    const caller = keyCaller({ id: "k", businessId: bizA, scope: "write" });
    const created = await caller.clients.create({ name: "Via key", contacts: [] });
    expect(created.businessId).toBe(bizA);
  });

  it("keeps the creator's own permissions (a viewer's key can't create)", async () => {
    const caller = keyCaller({ id: "k", businessId: bizA, scope: "write" }, "bob");
    await expect(
      caller.clients.create({ name: "Nope", contacts: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("can't reach a business the creator doesn't belong to", async () => {
    const caller = keyCaller({ id: "k", businessId: bizB, scope: "read" }, "bob");
    await expect(caller.clients.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("can't switch businesses, create one, or manage API keys", async () => {
    const caller = keyCaller({ id: "k", businessId: bizA, scope: "write" });
    await expect(caller.business.switch({ businessId: bizB })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.apiKeys.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.apiKeys.create({ name: "minted", scope: "write" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("apiKeys router (browser session)", () => {
  it("creates, lists and revokes keys in the active business", async () => {
    const alice = sessionCaller("alice"); // active business: B
    const { id, key } = await alice.apiKeys.create({ name: "Panel sync", scope: "write" });
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);

    const listed = await alice.apiKeys.list();
    const row = listed.find((k) => k.id === id);
    expect(row).toMatchObject({ name: "Panel sync", scope: "write", createdBy: "alice" });
    expect(row).not.toHaveProperty("keyHash");
    expect(JSON.stringify(listed)).not.toContain(key);
    // Business A's keys are not listed in B.
    expect(listed.every((k) => k.name !== "storage")).toBe(true);
    expect((await listApiKeys(db, bizA)).some((k) => k.name === "storage")).toBe(true);

    await alice.apiKeys.revoke({ keyId: id });
    expect(await verifyApiKey(db, key)).toBeNull();
    await expect(alice.apiKeys.revoke({ keyId: id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("is refused to a viewer", async () => {
    await expect(sessionCaller("bob").apiKeys.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("GET /api/v1/health", () => {
  it("answers 401 JSON without a key, or with a bad one", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    for (const res of [
      await GET(get("/api/v1/health")),
      await GET(get("/api/v1/health", `${API_KEY_PREFIX}wrong`)),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("reports the key's business and scope", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "health",
      scope: "read",
    });
    const res = await GET(get("/api/v1/health", key));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe(String(RATE_LIMIT_PER_MINUTE));
    expect(await res.json()).toMatchObject({
      status: "ok",
      business: { id: bizA, name: "Business A" },
      key: { id, name: "health", scope: "read" },
    });
  });

  it("answers 401 once the key is revoked", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "to revoke",
      scope: "read",
    });
    expect((await GET(get("/api/v1/health", key))).status).toBe(200);
    await revokeApiKey(db, bizA, id);
    expect((await GET(get("/api/v1/health", key))).status).toBe(401);
  });

  it("answers 401 once the creator leaves the business", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    await addUser("carol");
    const [member] = await db
      .insert(schema.businessMember)
      .values({ businessId: bizA, userId: "carol", role: "admin" })
      .returning();
    const { key } = await createApiKey(db, {
      businessId: bizA,
      userId: "carol",
      name: "carol",
      scope: "read",
    });
    expect((await GET(get("/api/v1/health", key))).status).toBe(200);
    await db.delete(schema.businessMember).where(eq(schema.businessMember.id, member.id));
    expect((await GET(get("/api/v1/health", key))).status).toBe(401);
  });

  it("answers 429 with Retry-After past the per-key limit", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "busy",
      scope: "read",
    });
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) takeRateLimit(id);
    const res = await GET(get("/api/v1/health", key));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("unknown /api/v1 paths", () => {
  it("answer a JSON 404", async () => {
    const { GET } = await import("@/app/api/v1/[...path]/route");
    const res = GET(get("/api/v1/nothing-here"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "No endpoint at GET /api/v1/nothing-here" },
    });
  });
});

describe("/api/mcp with an API key", () => {
  function initialize(key: string) {
    return new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
  }

  it("accepts a live key and refuses a revoked one", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const { id, key } = await createApiKey(db, {
      businessId: bizA,
      userId: "alice",
      name: "mcp",
      scope: "read",
    });
    const ok = await POST(initialize(key));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: { serverInfo: {} } });

    await revokeApiKey(db, bizA, id);
    expect((await POST(initialize(key))).status).toBe(401);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  const url = (q: string) => new URL(`http://localhost/api/v1/x${q}`);

  it("walks the list with the returned cursor", () => {
    const first = paginate(items, url("?limit=2"));
    expect(first.data).toEqual([0, 1]);
    const second = paginate(items, url(`?limit=2&cursor=${first.nextCursor}`));
    expect(second.data).toEqual([2, 3]);
    const last = paginate(items, url(`?limit=2&cursor=${second.nextCursor}`));
    expect(last).toEqual({ data: [4], nextCursor: null });
  });

  it("defaults to 50 and refuses bad limits and cursors with 422", () => {
    expect(paginate(items, url("")).data).toHaveLength(5);
    for (const q of ["?limit=0", "?limit=201", "?limit=abc", "?cursor=bogus"]) {
      expect(() => paginate(items, url(q))).toThrow(ApiError);
    }
  });
});

describe("error mapping", () => {
  it("maps tRPC errors to HTTP statuses with a JSON body", async () => {
    const cases: [TRPCError["code"], number, string][] = [
      ["UNAUTHORIZED", 401, "unauthorized"],
      ["FORBIDDEN", 403, "forbidden"],
      ["NOT_FOUND", 404, "not_found"],
      ["CONFLICT", 409, "conflict"],
      ["BAD_REQUEST", 422, "validation_failed"],
    ];
    for (const [code, status, slug] of cases) {
      const res = errorResponse(new TRPCError({ code, message: "m" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: { code: slug, message: "m" } });
    }
  });

  it("hides the message of unexpected errors", async () => {
    const res = errorResponse(new Error("database password is hunter2"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });
});
