import { PGlite } from "@electric-sql/pglite";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { insecureSecretProblem } from "@/lib/startup-checks";
import { receiptsSummaryCsv } from "@/modules/expenses/receipts-archive";
import { setMemberPermission } from "@/modules/team/service";
import { createApiKey } from "@/server/api-keys";
import { resetRateLimits, takeRateLimit } from "@/server/api/v1";
import type { Session } from "@/server/auth";
import { describeError } from "@/server/mcp/result";
import { publicErrorMessage } from "@/server/trpc/errors";

import { SECURITY_HEADERS } from "../lib/security-headers";
import { createCallerFactory } from "./trpc/init";
import { appRouter } from "./trpc/routers/_app";

// #5584: hardening items from the #5473 audit, against the real appRouter
// and route handlers on PGlite where they touch data.

const createCaller = createCallerFactory(appRouter);

let pglite: PGlite;
let db: Db;
let bizId = "";
let taskId = "";

function callerFor(userId: string) {
  return createCaller({
    headers: new Headers(),
    session: {
      user: { id: userId, name: userId, email: `${userId}@t.dev` },
      session: { id: `${userId}-s`, userId },
    } as unknown as Session,
  });
}

const logEntry = (userId: string) =>
  callerFor(userId).time.logManual({
    taskId,
    startedAt: new Date("2026-01-05T09:00:00Z"),
    durationSeconds: 3600,
    billable: true,
  });

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-hardening";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db
    .insert(schema.user)
    .values(["olive", "mike", "cora"].map((id) => ({ id, name: id, email: `${id}@t.dev` })));
  const [biz] = await db.insert(schema.business).values({ name: "Biz", currency: "EUR" }).returning();
  bizId = biz.id;
  await db.insert(schema.businessMember).values([
    { businessId: bizId, userId: "olive", role: "owner" },
    { businessId: bizId, userId: "mike", role: "member" },
    { businessId: bizId, userId: "cora", role: "contractor" },
  ]);
  // A contractor who may delete time but not see the team's.
  await setMemberPermission(db, bizId, "cora", "time.delete", "grant");

  const olive = callerFor("olive");
  const client = await olive.clients.create({
    name: "Acme",
    contacts: [],
    defaultRateMinor: 10000,
    defaultRateCurrency: "EUR",
  });
  const project = await olive.projects.create({ name: "Site", clientId: client.id });
  const task = await olive.tasks.create({ projectId: project.id, data: { title: "Build" } });
  taskId = task.id;
}, 60_000);

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(() => resetRateLimits());

describe("security headers", () => {
  it("sets HSTS, CSP with frame-ancestors, nosniff, frame and referrer policies", () => {
    const byName = new Map(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byName.get("strict-transport-security")).toMatch(/max-age=\d{7,}/);
    expect(byName.get("x-content-type-options")).toBe("nosniff");
    expect(byName.get("x-frame-options")).toBe("DENY");
    expect(byName.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const csp = byName.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});

describe("tRPC refuses form-encoded requests (CSRF)", () => {
  const post = async (contentType: string, body: BodyInit) => {
    const { POST } = await import("@/app/api/trpc/[trpc]/route");
    return POST(
      new Request("http://localhost/api/trpc/clients.create", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
    );
  };

  it("answers 415 to multipart, urlencoded and text/plain POSTs", async () => {
    const form = new FormData();
    form.set("name", "Evil");
    const multipart = await import("@/app/api/trpc/[trpc]/route").then(({ POST }) =>
      POST(new Request("http://localhost/api/trpc/clients.create", { method: "POST", body: form })),
    );
    expect(multipart.status).toBe(415);
    expect((await post("application/x-www-form-urlencoded", "name=Evil")).status).toBe(415);
    expect((await post("text/plain", '{"name":"Evil"}')).status).toBe(415);
  });

  it("still serves JSON POSTs (401 here: nobody is signed in)", async () => {
    const res = await post("application/json", JSON.stringify({ json: { name: "x" } }));
    expect(res.status).toBe(401);
  });
});

describe("time.deleteEntry", () => {
  it("lets a caller without time.viewAll delete only their own entries", async () => {
    const mine = await logEntry("cora");
    const mikes = await logEntry("mike");
    await expect(
      callerFor("cora").time.deleteEntry({ entryId: mikes.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor("cora").time.deleteEntry({ entryId: mine.id })).resolves.toMatchObject({
      id: mine.id,
    });
    // A member sees the team's time and may tidy it.
    await expect(callerFor("mike").time.deleteEntry({ entryId: mikes.id })).resolves.toMatchObject({
      id: mikes.id,
    });
  });

  it("refuses to delete time that is billed on an invoice line", async () => {
    const entry = await logEntry("mike");
    const olive = callerFor("olive");
    const [clientRow] = await db
      .select({ id: schema.client.id })
      .from(schema.client)
      .where(eq(schema.client.businessId, bizId));
    const draft = await olive.invoices.createDraft({
      clientId: clientRow.id,
      currency: "EUR",
      taxTreatment: "zero_rated",
    });
    await olive.invoices.addLine({ invoiceId: draft.id, description: "x", amountMajor: "1" });
    const [line] = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, draft.id));
    await db
      .update(schema.timeEntry)
      .set({ invoiceLineId: line.id })
      .where(eq(schema.timeEntry.id, entry.id));

    await expect(olive.time.deleteEntry({ entryId: entry.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [still] = await db
      .select({ id: schema.timeEntry.id })
      .from(schema.timeEntry)
      .where(eq(schema.timeEntry.id, entry.id));
    expect(still).toBeDefined();
  });
});

describe("time.logManual rate override", () => {
  it("needs clients.manageRates", async () => {
    await expect(
      callerFor("cora").time.logManual({
        taskId,
        startedAt: new Date("2026-01-06T09:00:00Z"),
        durationSeconds: 600,
        billable: true,
        rateMinor: 99_999,
        rateCurrency: "EUR",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ok = await callerFor("mike").time.logManual({
      taskId,
      startedAt: new Date("2026-01-06T10:00:00Z"),
      durationSeconds: 600,
      billable: true,
      rateMinor: 5000,
      rateCurrency: "EUR",
    });
    expect(ok).toMatchObject({ rateMinor: 5000 });
  });
});

describe("cron token", () => {
  it("refuses a wrong token of any length and accepts the right one", async () => {
    process.env.CLERQ_CRON_TOKEN = "s3cret-token";
    try {
      const { POST } = await import("@/app/api/cron/run/route");
      const call = (auth?: string) =>
        POST(
          new Request("http://localhost/api/cron/run", {
            method: "POST",
            headers: auth ? { authorization: auth } : {},
          }),
        );
      expect((await call()).status).toBe(401);
      expect((await call("Bearer s3cret-tokeN")).status).toBe(401);
      expect((await call("Bearer short")).status).toBe(401);
      expect((await call("Bearer s3cret-token")).status).toBe(200);
    } finally {
      delete process.env.CLERQ_CRON_TOKEN;
    }
  });
});

describe("/api/mcp with an API key", () => {
  it("is rate limited like the REST API", async () => {
    const key = await createApiKey(db, { businessId: bizId, userId: "olive", name: "mcp", scope: "read" });
    const [row] = await db
      .select({ id: schema.apiKey.id })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.name, "mcp"));
    for (let i = 0; i < 120; i += 1) takeRateLimit(row.id);
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  }, 30_000);
});

describe("receipts summary CSV", () => {
  it("defuses cells a spreadsheet would run as formulas", () => {
    const csv = receiptsSummaryCsv([
      {
        name: "r.pdf",
        row: {
          incurredAt: new Date("2026-01-05T00:00:00Z"),
          description: '=HYPERLINK("http://evil.example","x")',
          vendor: "+Vendor",
          category: "@cat",
          amountMinor: 1234,
          currency: "EUR",
          status: "paid",
        } as never,
      },
    ]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(line).toContain("'+Vendor");
    expect(line).toContain("'@cat");
    expect(line).toContain(",12.34,");
  });
});

describe("error messages", () => {
  const dbError = new DrizzleQueryError(
    'select "secret_column" from "invoice" where "id" = $1',
    ["x"],
    new Error("relation does not exist"),
  );

  it("never pass a database error's text on", () => {
    expect(publicErrorMessage(new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: dbError }))).toBe(
      "Something went wrong",
    );
    expect(describeError(dbError)).not.toMatch(/secret_column|Failed query/);
    expect(
      describeError(new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: dbError })),
    ).not.toMatch(/secret_column|Failed query/);
  });

  it("keep our own messages", () => {
    expect(publicErrorMessage(new TRPCError({ code: "NOT_FOUND", message: "No such invoice" }))).toBe(
      "No such invoice",
    );
    expect(describeError(new TRPCError({ code: "CONFLICT", message: "Billed" }))).toBe(
      "Conflict: Billed",
    );
  });
});

describe("startup checks", () => {
  it("refuses the compose file's default auth secret outside localhost", () => {
    const dev = "clerq-dev-secret-change-me";
    expect(
      insecureSecretProblem({ BETTER_AUTH_SECRET: dev, BETTER_AUTH_URL: "https://clerq.example.com" }),
    ).toMatch(/BETTER_AUTH_SECRET/);
    expect(insecureSecretProblem({ BETTER_AUTH_SECRET: dev, BETTER_AUTH_URL: undefined })).toMatch(
      /BETTER_AUTH_SECRET/,
    );
    expect(
      insecureSecretProblem({ BETTER_AUTH_SECRET: dev, BETTER_AUTH_URL: "http://localhost:3000" }),
    ).toBeNull();
    expect(
      insecureSecretProblem({
        BETTER_AUTH_SECRET: "a-real-long-random-secret",
        BETTER_AUTH_URL: "https://clerq.example.com",
      }),
    ).toBeNull();
  });
});
