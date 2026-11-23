import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import type { Session } from "@/server/auth";
import type { AppSession } from "@/server/session";

import { signInvoicePdfToken } from "./mcp/pdf-link";
import { createCallerFactory, type TRPCContext } from "./trpc/init";
import { appRouter } from "./trpc/routers/_app";

// #5583: permission gaps from the #5473 audit, against the real appRouter
// and route handlers on PGlite. The browser session is stubbed: each test
// picks who is "signed in" (and whether as an impersonating admin).

let signedIn: AppSession | null = null;
vi.mock("@/server/session", () => ({
  getEffectiveSession: async () => signedIn,
}));

const createCaller = createCallerFactory(appRouter);

let pglite: PGlite;
let db: Db;
let bizId = "";
let suspendedBizId = "";
let taskId = "";
let invoiceId = "";
let creditNoteId = "";

function sessionFor(userId: string, impersonating = false): AppSession {
  const session = {
    user: { id: userId, name: userId, email: `${userId}@t.dev` },
    session: { id: `${userId}-session`, userId },
  } as unknown as Session;
  if (!impersonating) return session;
  return {
    ...session,
    impersonation: {
      id: "imp-1",
      adminUserId: "admin",
      adminName: "Support",
      targetUserId: userId,
      reason: "test",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  };
}

function callerFor(
  userId: string,
  extra: Partial<Pick<TRPCContext, "apiKey" | "impersonation">> = {},
) {
  return createCaller({
    headers: new Headers(),
    session: sessionFor(userId) as Session,
    ...extra,
  });
}

async function sentAt(): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: schema.invoice.einvoiceSentAt })
    .from(schema.invoice)
    .where(eq(schema.invoice.id, invoiceId));
  return row.sentAt;
}

async function unmark() {
  await db
    .update(schema.invoice)
    .set({ einvoiceSentAt: null })
    .where(eq(schema.invoice.id, invoiceId));
}

const invoicePdf = () => import("@/app/api/invoices/[invoiceId]/pdf/route");
const invoiceXml = () => import("@/app/api/invoices/[invoiceId]/einvoice/route");
const creditPdf = () => import("@/app/api/credit-notes/[creditNoteId]/pdf/route");
const creditXml = () => import("@/app/api/credit-notes/[creditNoteId]/einvoice/route");

async function getInvoiceFile(kind: "pdf" | "einvoice", query = "") {
  const { GET } = kind === "pdf" ? await invoicePdf() : await invoiceXml();
  return GET(new Request(`http://localhost/api/invoices/${invoiceId}/${kind}${query}`), {
    params: Promise.resolve({ invoiceId }),
  });
}

async function getCreditNoteFile(kind: "pdf" | "einvoice") {
  const { GET } = kind === "pdf" ? await creditPdf() : await creditXml();
  return GET(new Request(`http://localhost/api/credit-notes/${creditNoteId}/${kind}`), {
    params: Promise.resolve({ creditNoteId }),
  });
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-download-access";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  const users = ["olive", "mike", "vera", "cora", "sam", "susi"];
  await db
    .insert(schema.user)
    .values(users.map((id) => ({ id, name: id, email: `${id}@t.dev` })));
  const [biz, suspended] = await db
    .insert(schema.business)
    .values([
      {
        name: "Biz",
        currency: "EUR",
        einvoicingEnabled: true,
        taxConfig: { vatNumber: "DE123456789" },
        postalAddress: {
          street: "Hauptstraße 5",
          city: "Berlin",
          postcode: "10115",
          region: null,
          country: "DE",
        },
      },
      { name: "Suspended Biz", currency: "EUR" },
    ])
    .returning();
  bizId = biz.id;
  suspendedBizId = suspended.id;
  await db.insert(schema.businessMember).values([
    { businessId: bizId, userId: "olive", role: "owner" },
    { businessId: bizId, userId: "mike", role: "member" },
    { businessId: bizId, userId: "vera", role: "viewer" },
    { businessId: bizId, userId: "cora", role: "contractor" },
    { businessId: bizId, userId: "sam", role: "owner" },
    { businessId: suspendedBizId, userId: "susi", role: "owner" },
  ]);
  await db.insert(schema.userSuspension).values({ userId: "sam", suspendedAt: new Date() });
  await db
    .insert(schema.businessSuspension)
    .values({ businessId: suspendedBizId, suspendedAt: new Date() });

  const olive = callerFor("olive");
  const client = await olive.clients.create({
    name: "Lumen Labs B.V.",
    contacts: [],
    vatNumber: "NL812345678B01",
    buyerReference: "PO-9",
    defaultRateMinor: 10000,
    defaultRateCurrency: "EUR",
    postalAddress: {
      street: "Keizersgracht 100",
      city: "Amsterdam",
      postcode: "1015 AA",
      region: null,
      country: "NL",
    },
  });
  await olive.clients.setMemberRate({
    clientId: client.id,
    data: {
      userId: "mike",
      billRateMinor: 12000,
      billRateCurrency: "EUR",
      internalCostMinor: 4500,
      internalCostCurrency: "EUR",
    },
  });
  const project = await olive.projects.create({ name: "Site", clientId: client.id });
  const task = await olive.tasks.create({ projectId: project.id, data: { title: "Build" } });
  taskId = task.id;

  const draft = await olive.invoices.createDraft({
    clientId: client.id,
    currency: "EUR",
    taxTreatment: "zero_rated",
  });
  invoiceId = draft.id;
  await olive.invoices.addLine({ invoiceId, description: "Design work", amountMajor: "500" });
  await olive.invoices.issue({ invoiceId });
  const note = await olive.invoices.issueCreditNote({ invoiceId, reason: "Partial refund" });
  creditNoteId = note.id;
  // A credit note sets credited_minor, which blocks voiding by itself; take
  // it back out so these tests only see einvoice_sent_at.
  await db
    .update(schema.invoice)
    .set({ creditedMinor: 0, status: "sent" })
    .where(eq(schema.invoice.id, invoiceId));
}, 60_000);

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(async () => {
  signedIn = null;
  await unmark();
});

describe("time entries' internal cost (#5583 item 1)", () => {
  it("is only returned to callers who may view profit", async () => {
    const mike = callerFor("mike");
    const logged = await mike.time.logManual({
      taskId,
      startedAt: new Date("2026-01-05T09:00:00Z"),
      durationSeconds: 3600,
      billable: true,
    });
    expect(logged).not.toHaveProperty("internalCostMinor");

    const forMike = await mike.time.listForTask({ taskId });
    expect(forMike).toHaveLength(1);
    expect(forMike[0]).not.toHaveProperty("internalCostMinor");
    expect(forMike[0]).not.toHaveProperty("internalCostCurrency");
    expect(forMike[0]).toMatchObject({ rateMinor: 12000 });

    const updated = await mike.time.updateNote({ entryId: logged.id, note: "x" });
    expect(updated).not.toHaveProperty("internalCostMinor");

    const forOlive = await callerFor("olive").time.listForTask({ taskId });
    expect(forOlive[0]).toMatchObject({
      internalCostMinor: 4500,
      internalCostCurrency: "EUR",
    });
  });
});

describe("browser download routes (#5583 item 2)", () => {
  it("refuses a contractor (no invoices.view) on all four routes", async () => {
    signedIn = sessionFor("cora");
    expect((await getInvoiceFile("pdf")).status).toBe(403);
    expect((await getInvoiceFile("einvoice")).status).toBe(403);
    expect((await getCreditNoteFile("pdf")).status).toBe(403);
    expect((await getCreditNoteFile("einvoice")).status).toBe(403);
    expect(await sentAt()).toBeNull();
    // The first test here imports the PDF renderer, which takes a while
    // during a full parallel run.
  }, 60_000);

  it("refuses a suspended account and a suspended business", async () => {
    signedIn = sessionFor("sam");
    expect((await getInvoiceFile("pdf")).status).toBe(403);
    expect((await getInvoiceFile("einvoice")).status).toBe(403);
    expect((await getCreditNoteFile("pdf")).status).toBe(403);
    expect((await getCreditNoteFile("einvoice")).status).toBe(403);

    signedIn = sessionFor("susi");
    expect((await getInvoiceFile("einvoice")).status).toBe(403);
    expect((await getCreditNoteFile("einvoice")).status).toBe(403);
  }, 30_000);

  it("still asks for a sign-in, and serves a viewer the files", async () => {
    expect((await getInvoiceFile("einvoice")).status).toBe(401);
    signedIn = sessionFor("vera");
    expect((await getCreditNoteFile("einvoice")).status).toBe(200);
  }, 30_000);
});

describe("marking an invoice sent as an e-invoice (#5583 item 3)", () => {
  it("XML route: a viewer or an impersonating admin downloads without marking", async () => {
    signedIn = sessionFor("vera");
    expect((await getInvoiceFile("einvoice")).status).toBe(200);
    expect(await sentAt()).toBeNull();

    signedIn = sessionFor("olive", true);
    expect((await getInvoiceFile("einvoice")).status).toBe(200);
    expect(await sentAt()).toBeNull();

    signedIn = sessionFor("mike");
    expect((await getInvoiceFile("einvoice")).status).toBe(200);
    expect(await sentAt()).not.toBeNull();
  }, 30_000);

  it("PDF route: a viewer's Factur-X PDF doesn't mark it; a member's does", async () => {
    signedIn = sessionFor("vera");
    const res = await getInvoiceFile("pdf");
    expect(res.status).toBe(200);
    expect(await sentAt()).toBeNull();

    signedIn = sessionFor("mike");
    expect((await getInvoiceFile("pdf")).status).toBe(200);
    expect(await sentAt()).not.toBeNull();
  }, 60_000);

  it("PDF link token: only marks when it was minted for a caller who could void", async () => {
    const quiet = signInvoicePdfToken({ invoiceId, businessId: bizId, markSent: false });
    expect((await getInvoiceFile("pdf", `?token=${quiet}`)).status).toBe(200);
    expect(await sentAt()).toBeNull();

    const marking = signInvoicePdfToken({ invoiceId, businessId: bizId, markSent: true });
    expect((await getInvoiceFile("pdf", `?token=${marking}`)).status).toBe(200);
    expect(await sentAt()).not.toBeNull();
  }, 60_000);

  it("tRPC einvoice({ download }) marks only for a caller who could void", async () => {
    const readKey = { id: "k-read", businessId: bizId, scope: "read" as const };
    await callerFor("olive", { apiKey: readKey }).invoices.einvoice({ invoiceId, download: true });
    expect(await sentAt()).toBeNull();

    await callerFor("vera").invoices.einvoice({ invoiceId, download: true });
    expect(await sentAt()).toBeNull();

    const impersonation = sessionFor("olive", true).impersonation;
    await callerFor("olive", { impersonation }).invoices.einvoice({
      invoiceId,
      download: true,
    });
    expect(await sentAt()).toBeNull();

    await callerFor("mike").invoices.einvoice({ invoiceId, download: true });
    expect(await sentAt()).not.toBeNull();
  });

  it("pdfLinkGrant tells MCP whether its link may mark the invoice", async () => {
    const readKey = { id: "k-read", businessId: bizId, scope: "read" as const };
    expect(
      await callerFor("olive", { apiKey: readKey }).invoices.pdfLinkGrant({ invoiceId }),
    ).toMatchObject({ markSent: false });
    expect(await callerFor("vera").invoices.pdfLinkGrant({ invoiceId })).toMatchObject({
      markSent: false,
    });
    expect(await callerFor("mike").invoices.pdfLinkGrant({ invoiceId })).toMatchObject({
      markSent: true,
    });
  });
});
