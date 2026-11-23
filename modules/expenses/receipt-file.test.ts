import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import type { Session } from "@/server/auth";
import type { AppSession } from "@/server/session";

import { decodeReceipt, receiptEtag, receiptResponse } from "./receipt-file";

// The expense receipt route (#5693): the expense page no longer inlines the
// base64 data URL, it loads the file from GET /api/expenses/[id]/receipt.
// The browser session is stubbed so each test picks who is signed in.

let signedIn: AppSession | null = null;
vi.mock("@/server/session", () => ({
  getEffectiveSession: async () => signedIn,
}));

const session = (userId: string) =>
  ({
    user: { id: userId, name: userId, email: `${userId}@t.dev` },
    session: { id: `${userId}-session`, userId },
  }) as unknown as Session;

// A 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

let pglite: PGlite;
let db: Db;
let expenseA = "";
let expenseNoReceipt = "";
let expenseB = "";

const route = () => import("@/app/api/expenses/[expenseId]/receipt/route");

async function get(expenseId: string, init: { query?: string; headers?: HeadersInit } = {}) {
  const { GET } = await route();
  return GET(
    new Request(`http://localhost/api/expenses/${expenseId}/receipt${init.query ?? ""}`, {
      headers: init.headers,
    }),
    { params: Promise.resolve({ expenseId }) },
  );
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);
  await db.insert(schema.user).values([
    { id: "owner-a", name: "A", email: "a@t.dev" },
    { id: "owner-b", name: "B", email: "b@t.dev" },
    { id: "contractor-a", name: "C", email: "c@t.dev" },
  ]);
  const [a, b] = await db
    .insert(schema.business)
    .values([
      { name: "A Co", currency: "EUR" },
      { name: "B Co", currency: "EUR" },
    ])
    .returning();
  await db.insert(schema.businessMember).values([
    { businessId: a.id, userId: "owner-a", role: "owner" },
    { businessId: b.id, userId: "owner-b", role: "owner" },
    { businessId: a.id, userId: "contractor-a", role: "contractor" },
  ]);
  const base = { amountMinor: 1000, currency: "EUR", incurredAt: new Date("2026-05-04T00:00:00Z") };
  const rows = await db
    .insert(schema.expense)
    .values([
      {
        ...base,
        businessId: a.id,
        description: "Lunch",
        receiptDataUrl: PNG_DATA_URL,
        receiptFilename: "lunch – café.png",
        receiptMimeType: "image/png",
      },
      { ...base, businessId: a.id, description: "No receipt" },
      {
        ...base,
        businessId: b.id,
        description: "Other business",
        receiptDataUrl: PNG_DATA_URL,
        receiptFilename: "b.png",
        receiptMimeType: "image/png",
      },
    ])
    .returning({ id: schema.expense.id });
  [expenseA, expenseNoReceipt, expenseB] = rows.map((r) => r.id);
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("GET /api/expenses/[expenseId]/receipt", () => {
  it("serves the decoded file inline, privately, with an ETag", async () => {
    signedIn = session("owner-a");
    const res = await get(expenseA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="lunch _ caf_.png"; filename*=UTF-8''lunch%20%E2%80%93%20caf%C3%A9.png`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
    expect(res.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  });

  it("answers 304 to a matching If-None-Match, and attaches on ?download=1", async () => {
    signedIn = session("owner-a");
    const first = await get(expenseA);
    const etag = first.headers.get("etag") as string;
    const again = await get(expenseA, { headers: { "if-none-match": `W/${etag}, "other"` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const download = await get(expenseA, { query: "?download=1" });
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("answers 404 for another business's expense, one without a receipt, and a malformed id", async () => {
    signedIn = session("owner-a");
    expect((await get(expenseB)).status).toBe(404);
    expect((await get(expenseNoReceipt)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    signedIn = session("owner-b");
    expect((await get(expenseB)).status).toBe(200);
  });

  it("refuses without a session (401) and without expenses.view (403)", async () => {
    signedIn = null;
    expect((await get(expenseA)).status).toBe(401);
    signedIn = session("contractor-a");
    expect((await get(expenseA)).status).toBe(403);
  });
});

describe("receipt-file helpers", () => {
  it("decodes a data URL and serves an unknown type as an opaque attachment", async () => {
    expect(decodeReceipt("not a data url")).toBeNull();
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const res = receiptResponse({ id: "x", dataUrl: svg, filename: "x.svg" });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("changes the ETag when the receipt changes", () => {
    const a = receiptEtag({ id: "x", dataUrl: PNG_DATA_URL, filename: null });
    const b = receiptEtag({ id: "x", dataUrl: `${PNG_DATA_URL.slice(0, -4)}AAA=`, filename: null });
    expect(a).not.toBe(b);
  });
});
