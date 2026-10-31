import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import { createApiKey } from "@/server/api-keys";
import { verifyInvoicePdfToken } from "@/server/mcp/pdf-link";
import { resetRateLimits } from "./v1";

// The /api/v1 invoices and recurring-invoices endpoints against in-process
// Postgres (PGlite via the getDb() seam), calling the real route handlers the
// way Next does: a Request plus { params: Promise<...> }.

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
  const raw =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
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

const clientsRoute = () => import("@/app/api/v1/clients/route");
const invoicesRoute = () => import("@/app/api/v1/invoices/route");
const invoiceRoute = () => import("@/app/api/v1/invoices/[invoiceId]/route");
const linesRoute = () => import("@/app/api/v1/invoices/[invoiceId]/lines/route");
const lineRoute = () => import("@/app/api/v1/invoices/[invoiceId]/lines/[lineId]/route");
const generateRoute = () =>
  import("@/app/api/v1/invoices/[invoiceId]/generate-from-time/route");
const issueRoute = () => import("@/app/api/v1/invoices/[invoiceId]/issue/route");
const markPaidRoute = () => import("@/app/api/v1/invoices/[invoiceId]/mark-paid/route");
const voidRoute = () => import("@/app/api/v1/invoices/[invoiceId]/void/route");
const duplicateRoute = () => import("@/app/api/v1/invoices/[invoiceId]/duplicate/route");
const pdfLinkRoute = () => import("@/app/api/v1/invoices/[invoiceId]/pdf-link/route");
const schedulesRoute = () => import("@/app/api/v1/recurring-invoices/route");
const scheduleRoute = () => import("@/app/api/v1/recurring-invoices/[scheduleId]/route");
const scheduleInvoicesRoute = () =>
  import("@/app/api/v1/recurring-invoices/[scheduleId]/invoices/route");
const scheduleStatusRoute = () =>
  import("@/app/api/v1/recurring-invoices/[scheduleId]/status/route");
const scheduleGenerateRoute = () =>
  import("@/app/api/v1/recurring-invoices/[scheduleId]/generate/route");

async function makeClient(key: string, name: string): Promise<string> {
  const { POST } = await clientsRoute();
  const res = await call(POST, "POST", "/api/v1/clients", key, { body: { name } });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function makeDraft(key: string, clientId: string): Promise<string> {
  const { POST } = await invoicesRoute();
  const res = await call(POST, "POST", "/api/v1/invoices", key, {
    body: { clientId, currency: "eur", taxTreatment: "zero_rated" },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addLine(key: string, invoiceId: string, amountMajor = "100.00") {
  const { POST } = await linesRoute();
  return call(POST, "POST", `/api/v1/invoices/${invoiceId}/lines`, key, {
    params: { invoiceId },
    body: { description: "Design work", amountMajor },
  });
}

async function issue(key: string, invoiceId: string) {
  const { POST } = await issueRoute();
  return call(POST, "POST", `/api/v1/invoices/${invoiceId}/issue`, key, {
    params: { invoiceId },
  });
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-api-v1-invoices";
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

describe("/api/v1/invoices", () => {
  it("creates a draft, edits its lines, dates and notes, and lists it", async () => {
    const clientId = await makeClient(writeA, "Acme Ltd");
    const otherClient = await makeClient(writeA, "Globex");
    const invoiceId = await makeDraft(writeA, clientId);
    await makeDraft(writeA, otherClient);

    const added = await addLine(writeA, invoiceId, "250.50");
    expect(added.status).toBe(201);
    expect(added.body.totalMinor).toBe(25050);
    const lineId = added.body.lines?.[0]?.id ?? (await getInvoice(invoiceId)).lines[0].id;

    // PATCH only the amount: the description stays.
    const { PATCH: patchLine, DELETE: deleteLine } = await lineRoute();
    const patched = await call(
      patchLine,
      "PATCH",
      `/api/v1/invoices/${invoiceId}/lines/${lineId}`,
      writeA,
      { params: { invoiceId, lineId }, body: { amountMajor: "300" } },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.totalMinor).toBe(30000);
    let invoice = await getInvoice(invoiceId);
    expect(invoice.lines[0].description).toBe("Design work");

    const { PATCH } = await invoiceRoute();
    const details = await call(PATCH, "PATCH", `/api/v1/invoices/${invoiceId}`, writeA, {
      params: { invoiceId },
      body: { dueDate: "2026-12-31", notes: "Thanks for your business" },
    });
    expect(details.status).toBe(200);
    expect(new Date(details.body.dueDate).toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(details.body.notes).toBe("Thanks for your business");

    // A half-set billing period is refused and changes nothing.
    const half = await call(PATCH, "PATCH", `/api/v1/invoices/${invoiceId}`, writeA, {
      params: { invoiceId },
      body: { periodStart: "2026-11-01", notes: "changed" },
    });
    expect(half.status).toBe(422);
    expect(half.body.error.message).toMatch(/^periodEnd: /);
    invoice = await getInvoice(invoiceId);
    expect(invoice.notes).toBe("Thanks for your business");

    const nothing = await call(PATCH, "PATCH", `/api/v1/invoices/${invoiceId}`, writeA, {
      params: { invoiceId },
      body: { status: "paid" },
    });
    expect(nothing.status).toBe(422);

    const { GET: list } = await invoicesRoute();
    const byClient = await call(list, "GET", `/api/v1/invoices?clientId=${clientId}`, readA);
    expect(byClient.status).toBe(200);
    expect(byClient.body.data.map((i: { id: string }) => i.id)).toEqual([invoiceId]);
    const drafts = await call(list, "GET", "/api/v1/invoices?status=draft", readA);
    expect(drafts.body.data).toHaveLength(2);
    const sent = await call(list, "GET", "/api/v1/invoices?status=sent", readA);
    expect(sent.body.data).toHaveLength(0);
    const bad = await call(list, "GET", "/api/v1/invoices?status=open", readA);
    expect(bad.status).toBe(422);

    const removed = await call(
      deleteLine,
      "DELETE",
      `/api/v1/invoices/${invoiceId}/lines/${lineId}`,
      writeA,
      { params: { invoiceId, lineId } },
    );
    expect(removed.status).toBe(200);
    expect((await getInvoice(invoiceId)).lines).toHaveLength(0);
  });

  it("names the field when a draft is invalid", async () => {
    const clientId = await makeClient(writeA, "Initech");
    const { POST } = await invoicesRoute();
    const res = await call(POST, "POST", "/api/v1/invoices", writeA, {
      body: { clientId, currency: "EUR", taxTreatment: "half" },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/^taxTreatment: /);

    const badDate = await call(POST, "POST", "/api/v1/invoices", writeA, {
      body: { clientId, currency: "EUR", taxTreatment: "zero_rated", dueDate: "soon" },
    });
    expect(badDate.status).toBe(422);
    expect(badDate.body.error.message).toBe("dueDate must be an ISO 8601 date");
  });

  it("issues, links the PDF, marks paid, and refuses changes after issue with 409", async () => {
    const clientId = await makeClient(writeA, "Umbrella");
    const invoiceId = await makeDraft(writeA, clientId);
    await addLine(writeA, invoiceId);

    const issued = await issue(writeA, invoiceId);
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe("sent");
    expect(issued.body.number).toBeTruthy();
    expect((await issue(writeA, invoiceId)).status).toBe(409);

    // delete an issued invoice -> 409
    const { DELETE, PATCH } = await invoiceRoute();
    const del = await call(DELETE, "DELETE", `/api/v1/invoices/${invoiceId}`, writeA, {
      params: { invoiceId },
    });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("conflict");
    expect(del.body.error.message).toMatch(/void/);
    const edit = await call(PATCH, "PATCH", `/api/v1/invoices/${invoiceId}`, writeA, {
      params: { invoiceId },
      body: { notes: "late" },
    });
    expect(edit.status).toBe(409);
    expect((await addLine(writeA, invoiceId)).status).toBe(409);

    const { GET: pdfLink } = await pdfLinkRoute();
    const link = await call(pdfLink, "GET", `/api/v1/invoices/${invoiceId}/pdf-link`, readA, {
      params: { invoiceId },
    });
    expect(link.status).toBe(200);
    const url = new URL(link.body.url);
    expect(url.pathname).toBe(`/api/invoices/${invoiceId}/pdf`);
    expect(verifyInvoicePdfToken(url.searchParams.get("token")!)).toMatchObject({
      invoiceId,
      businessId: bizA,
    });
    expect(link.body.expiresInSeconds).toBe(900);

    const { POST: markPaid } = await markPaidRoute();
    const paid = await call(markPaid, "POST", `/api/v1/invoices/${invoiceId}/mark-paid`, writeA, {
      params: { invoiceId },
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");

    // Paid is terminal: it can't be voided or paid again.
    const { POST: voidIt } = await voidRoute();
    const voided = await call(voidIt, "POST", `/api/v1/invoices/${invoiceId}/void`, writeA, {
      params: { invoiceId },
    });
    expect(voided.status).toBe(409);
    const again = await call(markPaid, "POST", `/api/v1/invoices/${invoiceId}/mark-paid`, writeA, {
      params: { invoiceId },
    });
    expect(again.status).toBe(409);
  });

  it("voids a sent invoice with a reason, duplicates it, and deletes the draft copy", async () => {
    const clientId = await makeClient(writeA, "Hooli");
    const invoiceId = await makeDraft(writeA, clientId);
    await addLine(writeA, invoiceId);

    // A draft can't be voided or paid: it isn't a document yet.
    const { POST: voidIt } = await voidRoute();
    const { POST: markPaid } = await markPaidRoute();
    expect(
      (await call(voidIt, "POST", `/api/v1/invoices/${invoiceId}/void`, writeA, {
        params: { invoiceId },
      })).status,
    ).toBe(409);
    expect(
      (await call(markPaid, "POST", `/api/v1/invoices/${invoiceId}/mark-paid`, writeA, {
        params: { invoiceId },
      })).status,
    ).toBe(409);

    await issue(writeA, invoiceId);
    const voided = await call(voidIt, "POST", `/api/v1/invoices/${invoiceId}/void`, writeA, {
      params: { invoiceId },
      body: { reason: "Wrong client" },
    });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("void");
    expect(voided.body.voidReason).toBe("Wrong client");

    const { POST: duplicate } = await duplicateRoute();
    const copy = await call(duplicate, "POST", `/api/v1/invoices/${invoiceId}/duplicate`, writeA, {
      params: { invoiceId },
    });
    expect(copy.status).toBe(201);
    expect(copy.body.status).toBe("draft");
    expect(copy.body.number).toBeNull();
    const copyId = copy.body.id;

    const { DELETE, GET } = await invoiceRoute();
    const del = await call(DELETE, "DELETE", `/api/v1/invoices/${copyId}`, writeA, {
      params: { invoiceId: copyId },
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    const gone = await call(GET, "GET", `/api/v1/invoices/${copyId}`, readA, {
      params: { invoiceId: copyId },
    });
    expect(gone.status).toBe(404);
  });

  it("explains when there is no time to generate lines from", async () => {
    const clientId = await makeClient(writeA, "Stark");
    const invoiceId = await makeDraft(writeA, clientId);
    const { POST } = await generateRoute();
    const res = await call(POST, "POST", `/api/v1/invoices/${invoiceId}/generate-from-time`, writeA, {
      params: { invoiceId },
      body: { grouping: "task" },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/nothing_to_bill/);

    const bad = await call(POST, "POST", `/api/v1/invoices/${invoiceId}/generate-from-time`, writeA, {
      params: { invoiceId },
      body: { grouping: "by_magic" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/^grouping: /);
  });

  it("keeps read-only keys and other businesses out", async () => {
    const clientId = await makeClient(writeA, "Wayne");
    const invoiceId = await makeDraft(writeA, clientId);

    expect((await addLine(readA, invoiceId)).status).toBe(403);
    expect((await issue(readA, invoiceId)).status).toBe(403);
    const { DELETE, GET } = await invoiceRoute();
    expect(
      (await call(DELETE, "DELETE", `/api/v1/invoices/${invoiceId}`, readA, {
        params: { invoiceId },
      })).status,
    ).toBe(403);

    // Business B's key can't see or touch A's invoice.
    expect(
      (await call(GET, "GET", `/api/v1/invoices/${invoiceId}`, writeB, {
        params: { invoiceId },
      })).status,
    ).toBe(404);
    expect((await issue(writeB, invoiceId)).status).toBe(404);
    const { GET: pdfLink } = await pdfLinkRoute();
    expect(
      (await call(pdfLink, "GET", `/api/v1/invoices/${invoiceId}/pdf-link`, writeB, {
        params: { invoiceId },
      })).status,
    ).toBe(404);
    const { GET: list } = await invoicesRoute();
    const listB = await call(list, "GET", "/api/v1/invoices", writeB);
    expect(listB.body.data).toHaveLength(0);

    // A line of another invoice is not a line of this one.
    const otherId = await makeDraft(writeA, clientId);
    const added = await addLine(writeA, otherId);
    const lineId = added.body.lines?.[0]?.id ?? (await getInvoice(otherId)).lines[0].id;
    const { PATCH } = await lineRoute();
    const res = await call(PATCH, "PATCH", `/api/v1/invoices/${invoiceId}/lines/${lineId}`, writeA, {
      params: { invoiceId, lineId },
      body: { description: "Moved" },
    });
    expect(res.status).toBe(404);
  });
});

describe("/api/v1/recurring-invoices", () => {
  it("creates, patches, pauses, generates, lists generated and deletes a schedule", async () => {
    const clientId = await makeClient(writeA, "Retainer Co");
    const { GET: list, POST } = await schedulesRoute();
    const createdRes = await call(POST, "POST", "/api/v1/recurring-invoices", writeA, {
      body: {
        clientId,
        name: "Monthly retainer",
        currency: "EUR",
        taxTreatment: "zero_rated",
        frequency: "monthly",
        interval: 1,
        startDate: "2027-01-01",
        netTermsDays: 14,
        autoIssue: false,
        lines: [{ description: "Retainer", amountMajor: "1500.50" }],
      },
    });
    expect(createdRes.status).toBe(201);
    const scheduleId = createdRes.body.id;

    const listed = await call(list, "GET", "/api/v1/recurring-invoices?status=active", readA);
    expect(listed.body.data.map((s: { id: string }) => s.id)).toContain(scheduleId);

    // PATCH only the name: lines, amounts and dates keep their values.
    const { GET, PATCH, DELETE } = await scheduleRoute();
    const patched = await call(PATCH, "PATCH", `/api/v1/recurring-invoices/${scheduleId}`, writeA, {
      params: { scheduleId },
      body: { name: "Retainer 2027" },
    });
    expect(patched.status).toBe(200);
    const got = await call(GET, "GET", `/api/v1/recurring-invoices/${scheduleId}`, readA, {
      params: { scheduleId },
    });
    expect(got.body.name).toBe("Retainer 2027");
    expect(got.body.netTermsDays).toBe(14);
    expect(new Date(got.body.startDate).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(got.body.lines).toMatchObject([{ description: "Retainer", amountMinor: 150050 }]);

    const { POST: setStatus } = await scheduleStatusRoute();
    const { POST: generate } = await scheduleGenerateRoute();
    const paused = await call(setStatus, "POST", `/api/v1/recurring-invoices/${scheduleId}/status`, writeA, {
      params: { scheduleId },
      body: { status: "paused" },
    });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("paused");
    const refused = await call(generate, "POST", `/api/v1/recurring-invoices/${scheduleId}/generate`, writeA, {
      params: { scheduleId },
    });
    expect(refused.status).toBe(409);

    await call(setStatus, "POST", `/api/v1/recurring-invoices/${scheduleId}/status`, writeA, {
      params: { scheduleId },
      body: { status: "active" },
    });
    const generated = await call(generate, "POST", `/api/v1/recurring-invoices/${scheduleId}/generate`, writeA, {
      params: { scheduleId },
    });
    expect(generated.status).toBe(200);
    expect(generated.body).toMatchObject({ generated: 1, issued: false, error: null });

    const { GET: history } = await scheduleInvoicesRoute();
    const invoices = await call(history, "GET", `/api/v1/recurring-invoices/${scheduleId}/invoices`, readA, {
      params: { scheduleId },
    });
    expect(invoices.status).toBe(200);
    expect(invoices.body.data).toHaveLength(1);

    const deleted = await call(DELETE, "DELETE", `/api/v1/recurring-invoices/${scheduleId}`, writeA, {
      params: { scheduleId },
    });
    expect(deleted.status).toBe(200);
    const gone = await call(GET, "GET", `/api/v1/recurring-invoices/${scheduleId}`, readA, {
      params: { scheduleId },
    });
    expect(gone.status).toBe(404);
    // The invoice it generated stays.
    const { GET: invoiceList } = await invoicesRoute();
    const all = await call(invoiceList, "GET", `/api/v1/invoices?clientId=${clientId}`, readA);
    expect(all.body.data).toHaveLength(1);
  });

  it("validates bodies and keeps read-only keys and other businesses out", async () => {
    const clientId = await makeClient(writeA, "Strict Co");
    const { POST, GET: list } = await schedulesRoute();
    const body = {
      clientId,
      name: "Weekly",
      currency: "EUR",
      taxTreatment: "zero_rated",
      frequency: "weekly",
      interval: 1,
      startDate: "2027-02-01",
      netTermsDays: 0,
      autoIssue: false,
      lines: [],
    };
    const noLines = await call(POST, "POST", "/api/v1/recurring-invoices", writeA, { body });
    expect(noLines.status).toBe(422);
    expect(noLines.body.error.message).toMatch(/^lines: /);

    const ro = await call(POST, "POST", "/api/v1/recurring-invoices", readA, {
      body: { ...body, lines: [{ description: "x", amountMajor: "1" }] },
    });
    expect(ro.status).toBe(403);

    const ok = await call(POST, "POST", "/api/v1/recurring-invoices", writeA, {
      body: { ...body, lines: [{ description: "x", amountMajor: "1" }] },
    });
    const scheduleId = ok.body.id;
    const { GET } = await scheduleRoute();
    expect(
      (await call(GET, "GET", `/api/v1/recurring-invoices/${scheduleId}`, writeB, {
        params: { scheduleId },
      })).status,
    ).toBe(404);
    const { GET: history } = await scheduleInvoicesRoute();
    expect(
      (await call(history, "GET", `/api/v1/recurring-invoices/${scheduleId}/invoices`, writeB, {
        params: { scheduleId },
      })).status,
    ).toBe(404);
    expect((await call(list, "GET", "/api/v1/recurring-invoices?status=done", readA)).status).toBe(422);
    const { POST: setStatus } = await scheduleStatusRoute();
    const badStatus = await call(setStatus, "POST", `/api/v1/recurring-invoices/${scheduleId}/status`, writeA, {
      params: { scheduleId },
      body: { status: "stopped" },
    });
    expect(badStatus.status).toBe(422);
    expect(badStatus.body.error.message).toMatch(/^status: /);
  });
});

async function getInvoice(invoiceId: string) {
  const { GET } = await invoiceRoute();
  const res = await call(GET, "GET", `/api/v1/invoices/${invoiceId}`, readA, {
    params: { invoiceId },
  });
  expect(res.status).toBe(200);
  return res.body;
}
