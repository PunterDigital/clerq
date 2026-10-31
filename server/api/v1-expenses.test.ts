import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import { createApiKey } from "@/server/api-keys";
import { resetRateLimits } from "./v1";

// The /api/v1 expenses endpoints against in-process Postgres (PGlite via the
// getDb() seam), calling the real route handlers the way Next does: a Request
// plus { params: Promise<...> }.

let pglite: PGlite;
let db: Db;

// "alice" owns business A and business B. writeA / readA are her keys in A;
// writeB is her key in B, used to make records A's keys must not reach.
let bizA = "";
let writeA = "";
let readA = "";
let writeB = "";

type Handler = (
  req: Request,
  segment?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type Result = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  handler: unknown,
  method: string,
  path: string,
  key: string,
  opts: { body?: unknown; params?: Record<string, string> } = {},
): Promise<Result> {
  const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await (handler as Handler)(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(raw === undefined ? {} : { "content-type": "application/json" }),
      },
      body: raw,
    }),
    opts.params ? { params: Promise.resolve(opts.params) } : undefined,
  );
  return { status: res.status, body: await res.json() };
}

const expensesRoute = () => import("@/app/api/v1/expenses/route");
const expenseRoute = () => import("@/app/api/v1/expenses/[expenseId]/route");
const statusRoute = () => import("@/app/api/v1/expenses/[expenseId]/status/route");

async function makeExpense(
  key: string,
  body: Record<string, unknown> = {},
): Promise<Result> {
  const { POST } = await expensesRoute();
  return call(POST, "POST", "/api/v1/expenses", key, {
    body: {
      description: "Laptop stand",
      amountMinor: 4999,
      currency: "eur",
      incurredAt: "2026-09-15",
      ...body,
    },
  });
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-api-v1-expenses";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db.insert(schema.user).values({ id: "alice", name: "alice", email: "alice@t.dev" });
  const [a, b] = await db
    .insert(schema.business)
    .values([
      { name: "Business A", currency: "EUR" },
      { name: "Business B", currency: "EUR" },
    ])
    .returning();
  bizA = a.id;
  await db.insert(schema.businessMember).values([
    { businessId: bizA, userId: "alice", role: "owner" },
    { businessId: b.id, userId: "alice", role: "owner" },
  ]);
  await db.insert(schema.userActiveBusiness).values({ userId: "alice", businessId: bizA });

  const key = (businessId: string, scope: "read" | "write") =>
    createApiKey(db, { businessId, userId: "alice", name: scope, scope }).then((k) => k.key);
  writeA = await key(bizA, "write");
  readA = await key(bizA, "read");
  writeB = await key(b.id, "write");
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(() => resetRateLimits());

describe("/api/v1/expenses", () => {
  it("creates, reads, patches, marks paid and deletes an expense", async () => {
    const createdRes = await makeExpense(writeA, { vendor: "Ikea", category: "Office" });
    expect(createdRes.status).toBe(201);
    expect(createdRes.body).toMatchObject({
      description: "Laptop stand",
      amountMinor: 4999,
      currency: "EUR",
      status: "unpaid",
    });
    const expenseId = createdRes.body.id;

    // PATCH only the amount: the vendor, category and date stay.
    const { GET, PATCH, DELETE } = await expenseRoute();
    const patched = await call(PATCH, "PATCH", `/api/v1/expenses/${expenseId}`, writeA, {
      params: { expenseId },
      body: { amountMinor: 5499, notes: "Second one" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      amountMinor: 5499,
      vendor: "Ikea",
      category: "Office",
      notes: "Second one",
    });
    expect(new Date(patched.body.incurredAt).toISOString()).toBe("2026-09-15T00:00:00.000Z");

    // null clears an optional field.
    const cleared = await call(PATCH, "PATCH", `/api/v1/expenses/${expenseId}`, writeA, {
      params: { expenseId },
      body: { vendor: null },
    });
    expect(cleared.body.vendor).toBeNull();

    const { POST: setStatus } = await statusRoute();
    const paid = await call(setStatus, "POST", `/api/v1/expenses/${expenseId}/status`, writeA, {
      params: { expenseId },
      body: { status: "paid" },
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");
    expect(paid.body.paidAt).toBeTruthy();
    const unpaid = await call(setStatus, "POST", `/api/v1/expenses/${expenseId}/status`, writeA, {
      params: { expenseId },
      body: { status: "unpaid" },
    });
    expect(unpaid.body.status).toBe("unpaid");
    const bad = await call(setStatus, "POST", `/api/v1/expenses/${expenseId}/status`, writeA, {
      params: { expenseId },
      body: { status: "approved" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/^status: /);

    const deleted = await call(DELETE, "DELETE", `/api/v1/expenses/${expenseId}`, writeA, {
      params: { expenseId },
    });
    expect(deleted.status).toBe(200);
    const gone = await call(GET, "GET", `/api/v1/expenses/${expenseId}`, readA, {
      params: { expenseId },
    });
    expect(gone.status).toBe(404);
  });

  it("filters by status, date range and search", async () => {
    const sept = (await makeExpense(writeA, { description: "Train ticket", incurredAt: "2026-09-02" })).body.id;
    const oct = (await makeExpense(writeA, { description: "Hosting", incurredAt: "2026-10-01T08:00:00Z" })).body.id;
    const { POST: setStatus } = await statusRoute();
    await call(setStatus, "POST", `/api/v1/expenses/${oct}/status`, writeA, {
      params: { expenseId: oct },
      body: { status: "paid" },
    });

    const { GET: list } = await expensesRoute();
    const ids = async (query: string) => {
      const res = await call(list, "GET", `/api/v1/expenses${query}`, readA);
      expect(res.status).toBe(200);
      return res.body.data.map((e: { id: string }) => e.id);
    };
    expect(await ids("?status=paid")).toEqual([oct]);
    const september = await ids("?from=2026-09-01&to=2026-10-01");
    expect(september).toContain(sept);
    expect(september).not.toContain(oct);
    expect(await ids("?from=2026-10-01")).toEqual([oct]);
    expect(await ids("?search=train")).toEqual([sept]);

    expect((await call(list, "GET", "/api/v1/expenses?status=open", readA)).status).toBe(422);
    expect((await call(list, "GET", "/api/v1/expenses?from=2026-10-01&to=2026-09-01", readA)).status).toBe(422);
    expect((await call(list, "GET", "/api/v1/expenses?from=yesterday", readA)).status).toBe(422);
  });

  it("names the field when a body is invalid, and refuses receipts", async () => {
    const noAmount = await makeExpense(writeA, { amountMinor: -5 });
    expect(noAmount.status).toBe(422);
    expect(noAmount.body.error.message).toMatch(/^amountMinor: /);
    const badDate = await makeExpense(writeA, { incurredAt: "soon" });
    expect(badDate.status).toBe(422);
    expect(badDate.body.error.message).toBe("incurredAt must be an ISO 8601 date");

    const withReceipt = await makeExpense(writeA, {
      receipt: { dataUrl: "data:image/png;base64,AAAA", filename: "r.png", mimeType: "image/png" },
    });
    expect(withReceipt.status).toBe(422);
    expect(withReceipt.body.error.message).toMatch(/^receipt: .*in the app/);
  });

  it("never sends the receipt file, and keeps it on PATCH", async () => {
    const expenseId = (await makeExpense(writeA, { description: "Receipted" })).body.id;
    // A receipt attached in the app.
    await db
      .update(schema.expense)
      .set({
        receiptDataUrl: "data:image/png;base64,AAAA",
        receiptFilename: "receipt.png",
        receiptMimeType: "image/png",
      })
      .where(eq(schema.expense.id, expenseId));

    const { GET, PATCH } = await expenseRoute();
    const got = await call(GET, "GET", `/api/v1/expenses/${expenseId}`, readA, {
      params: { expenseId },
    });
    expect(got.body.receiptFilename).toBe("receipt.png");
    expect(got.body).not.toHaveProperty("receiptDataUrl");

    const patched = await call(PATCH, "PATCH", `/api/v1/expenses/${expenseId}`, writeA, {
      params: { expenseId },
      body: { description: "Receipted, renamed" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).not.toHaveProperty("receiptDataUrl");
    const [row] = await db
      .select()
      .from(schema.expense)
      .where(eq(schema.expense.id, expenseId));
    expect(row.receiptDataUrl).toBe("data:image/png;base64,AAAA");
    expect(row.description).toBe("Receipted, renamed");
  });

  it("keeps read-only keys and other businesses out", async () => {
    const expenseId = (await makeExpense(writeA)).body.id;
    expect((await makeExpense(readA)).status).toBe(403);
    const { GET, PATCH, DELETE } = await expenseRoute();
    expect(
      (await call(PATCH, "PATCH", `/api/v1/expenses/${expenseId}`, readA, {
        params: { expenseId },
        body: { amountMinor: 1 },
      })).status,
    ).toBe(403);
    const { POST: setStatus } = await statusRoute();
    expect(
      (await call(setStatus, "POST", `/api/v1/expenses/${expenseId}/status`, readA, {
        params: { expenseId },
        body: { status: "paid" },
      })).status,
    ).toBe(403);
    expect(
      (await call(DELETE, "DELETE", `/api/v1/expenses/${expenseId}`, readA, {
        params: { expenseId },
      })).status,
    ).toBe(403);

    expect(
      (await call(GET, "GET", `/api/v1/expenses/${expenseId}`, writeB, {
        params: { expenseId },
      })).status,
    ).toBe(404);
    expect(
      (await call(DELETE, "DELETE", `/api/v1/expenses/${expenseId}`, writeB, {
        params: { expenseId },
      })).status,
    ).toBe(404);
    const { GET: list } = await expensesRoute();
    expect((await call(list, "GET", "/api/v1/expenses", writeB)).body.data).toHaveLength(0);
    expect(
      (await call(GET, "GET", "/api/v1/expenses/not-a-uuid", readA, {
        params: { expenseId: "not-a-uuid" },
      })).status,
    ).toBe(404);
  });
});
