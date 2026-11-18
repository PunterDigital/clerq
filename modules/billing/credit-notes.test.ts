import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { createClient } from "@/modules/clients/service";
import { createProject } from "@/modules/projects/service";
import { createTask } from "@/modules/projects/tasks-service";
import { profitSummary } from "@/modules/reports/profit";
import { logManualEntry } from "@/modules/time/service";

import {
  formatCreditNoteNumber,
  getCreditNote,
  getInvoiceCredits,
  issueCreditNote,
  listCreditNotes,
  recordEinvoiceSent,
  voidBlockedReason,
} from "./credit-notes";
import { addManualLine, generateLinesFromUnbilledTime } from "./generate";
import { createDraftInvoice, issueInvoice } from "./invoices";
import { getInvoice, markInvoicePaid, voidInvoice } from "./lifecycle";
import { buildCreditNotePdfData } from "./pdf-data";

let pglite: PGlite;
let db: Db;
let business: { id: string };
let other: { id: string };
let client: { id: string };
let otherClient: { id: string };
const user = "user-a";
const ISSUED = new Date("2026-06-01T12:00:00Z");
const CREDITED = new Date("2026-06-15T12:00:00Z");

// An issued 21% VAT invoice with the given manual line amounts.
async function issued(amounts: string[], businessId = business.id, clientId = client.id) {
  const draft = (await createDraftInvoice(db, businessId, {
    clientId,
    currency: "EUR",
    taxTreatment: "standard",
    standardRatePercent: "21",
  })) as { id: string };
  for (const [i, amountMajor] of amounts.entries()) {
    const added = await addManualLine(db, businessId, {
      invoiceId: draft.id,
      description: `Line ${i + 1}`,
      amountMajor,
    });
    if (!added.ok) throw new Error("test setup: add line failed");
  }
  const result = await issueInvoice(db, businessId, draft.id, ISSUED);
  if (!result.ok) throw new Error("test setup: issue failed");
  return (await getInvoice(db, businessId, draft.id))!;
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  [business] = await db
    .insert(schema.business)
    .values({ name: "Alpha", currency: "EUR", taxConfig: { standardRatePct: "21" } })
    .returning();
  [other] = await db
    .insert(schema.business)
    .values({ name: "Beta", currency: "EUR", creditNotePrefix: "CR/" })
    .returning();
  await db.insert(schema.user).values([{ id: user, name: "Ada", email: "ada@alpha.test" }]);
  client = await createClient(db, business.id, user, { name: "Northwind", contacts: [] });
  otherClient = await createClient(db, other.id, user, { name: "Acme", contacts: [] });
});

afterAll(async () => {
  await pglite.close();
});

describe("credit notes (#5042)", () => {
  it("formats numbers with the prefix, year and four digits", () => {
    expect(formatCreditNoteNumber("CN-", 2026, 1)).toBe("CN-2026-0001");
    expect(formatCreditNoteNumber("", 2026, 42)).toBe("2026-0042");
  });

  it("credits a whole invoice in one go and closes it as credited", async () => {
    const invoice = await issued(["100.00", "50.00"]);
    expect(invoice.totalMinor).toBe(18150);

    const result = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      reason: "Wrong client",
    }, CREDITED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.creditNote).toMatchObject({
      number: "CN-2026-0001",
      subtotalMinor: 15000,
      taxMinor: 3150,
      totalMinor: 18150,
      taxRatePercent: "21",
      reason: "Wrong client",
      invoiceId: invoice.id,
    });

    const after = (await getInvoice(db, business.id, invoice.id))!;
    expect(after.status).toBe("credited");
    expect(after.creditedMinor).toBe(18150);

    const note = (await getCreditNote(db, business.id, result.creditNote.id))!;
    expect(note.invoiceNumber).toBe(invoice.number);
    expect(note.lines.map((l) => [l.description, l.totalMinor])).toEqual([
      ["Line 1", 10000],
      ["Line 2", 5000],
    ]);

    const credits = (await getInvoiceCredits(db, business.id, invoice.id))!;
    expect(credits.canCredit).toBe(false);
    expect(credits.remainingMinor).toBe(0);
    expect(credits.creditNotes).toHaveLength(1);

    // Logged on the client's thread.
    const [activity] = await db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.type, "credit_note_issued"));
    expect(activity.payload).toMatchObject({
      number: "CN-2026-0001",
      invoiceNumber: invoice.number,
      totalMinor: 18150,
    });

    // Nothing left: a second credit note is refused.
    const again = await issueCreditNote(db, business.id, user, { invoiceId: invoice.id });
    expect(again).toMatchObject({ ok: false, reason: "not_creditable" });
  });

  it("credits part of an invoice, then the rest, without the tax drifting", async () => {
    // 3 x 0.50: the invoice's tax is 21% of 1.50 = 0.315 -> 32, but each
    // 0.50 line alone rounds 0.105 -> 11, so three notes would credit 33.
    const invoice = await issued(["0.50", "0.50", "0.50"]);
    expect(invoice.taxMinor).toBe(32);
    const [l1, l2] = invoice.lines;

    const first = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: l1.id, amountMinor: 50 }],
    }, CREDITED);
    expect(first.ok && first.creditNote).toMatchObject({
      number: "CN-2026-0002",
      subtotalMinor: 50,
      taxMinor: 11,
      totalMinor: 61,
    });
    let after = (await getInvoice(db, business.id, invoice.id))!;
    expect(after.status).toBe("sent");
    expect(after.creditedMinor).toBe(61);

    // More than a line has left is refused, and so is a line of another invoice.
    const over = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: l1.id, amountMinor: 1 }],
    });
    expect(over).toMatchObject({ ok: false, reason: "invalid_line" });
    const elsewhere = await issued(["10.00"]);
    const foreign = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: elsewhere.lines[0].id, amountMinor: 100 }],
    });
    expect(foreign).toMatchObject({ ok: false, reason: "invalid_line" });

    const second = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: l2.id, amountMinor: 50 }],
    }, CREDITED);
    expect(second.ok && second.creditNote.taxMinor).toBe(11);

    // The last note takes exactly what is left of the tax: 32 - 22.
    const last = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
    }, CREDITED);
    expect(last.ok && last.creditNote).toMatchObject({
      subtotalMinor: 50,
      taxMinor: 10,
      totalMinor: 60,
    });
    after = (await getInvoice(db, business.id, invoice.id))!;
    expect(after.creditedMinor).toBe(after.totalMinor);
    expect(after.status).toBe("credited");
  });

  it("copies the hours breakdown only when a whole line is credited", async () => {
    const invoice = await issued(["80.00", "20.00"]);
    const partial = await issueCreditNote(db, business.id, user, {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: invoice.lines[0].id, amountMinor: 8000 },
        { invoiceLineId: invoice.lines[1].id, amountMinor: 500 },
      ],
    }, CREDITED);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    const note = (await getCreditNote(db, business.id, partial.creditNote.id))!;
    expect(note.lines.map((l) => [l.totalMinor, l.unitCode])).toEqual([
      [8000, invoice.lines[0].unitCode],
      [500, "C62"],
    ]);
  });

  it("refuses drafts, voided invoices and zero amounts", async () => {
    const draft = (await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "zero_rated",
    })) as { id: string };
    expect(
      await issueCreditNote(db, business.id, user, { invoiceId: draft.id }),
    ).toMatchObject({ ok: false, reason: "not_creditable" });

    const voided = await issued(["10.00"]);
    await voidInvoice(db, business.id, user, voided.id);
    expect(
      await issueCreditNote(db, business.id, user, { invoiceId: voided.id }),
    ).toMatchObject({ ok: false, reason: "not_creditable" });

    const invoice = await issued(["10.00"]);
    expect(
      await issueCreditNote(db, business.id, user, {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: invoice.lines[0].id, amountMinor: 0 }],
      }),
    ).toMatchObject({ ok: false, reason: "nothing_to_credit" });

    // Another business's invoice is invisible.
    expect(
      await issueCreditNote(db, other.id, user, { invoiceId: invoice.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("keeps a paid invoice paid when it is credited", async () => {
    const invoice = await issued(["40.00"]);
    await markInvoicePaid(db, business.id, invoice.id);
    const result = await issueCreditNote(db, business.id, user, { invoiceId: invoice.id }, CREDITED);
    expect(result.ok).toBe(true);
    const after = (await getInvoice(db, business.id, invoice.id))!;
    expect(after.status).toBe("paid");
    expect(after.creditedMinor).toBe(after.totalMinor);
  });

  it("numbers each business's credit notes on their own, with its prefix", async () => {
    const invoice = await issued(["10.00"], other.id, otherClient.id);
    const result = await issueCreditNote(db, other.id, user, { invoiceId: invoice.id }, CREDITED);
    expect(result.ok && result.creditNote.number).toBe("CR/2026-0001");
    const list = await listCreditNotes(db, other.id);
    expect(list.map((n) => n.number)).toEqual(["CR/2026-0001"]);
    expect(list[0]).toMatchObject({ clientName: "Acme", invoiceNumber: invoice.number });
  });

  it("only voids invoices that never went out as an e-invoice and have no credit notes", async () => {
    const sentAsEinvoice = await issued(["10.00"]);
    await recordEinvoiceSent(db, business.id, sentAsEinvoice.id, new Date("2026-06-02T00:00:00Z"));
    // The first time is kept.
    await recordEinvoiceSent(db, business.id, sentAsEinvoice.id, new Date("2026-06-09T00:00:00Z"));
    const reread = (await getInvoice(db, business.id, sentAsEinvoice.id))!;
    expect(reread.einvoiceSentAt).toEqual(new Date("2026-06-02T00:00:00Z"));
    expect(voidBlockedReason(reread)).toMatch(/credit note instead/);
    expect((await getInvoiceCredits(db, business.id, sentAsEinvoice.id))!.canVoid).toBe(false);
    expect(await voidInvoice(db, business.id, user, sentAsEinvoice.id)).toBeNull();

    const partlyCredited = await issued(["10.00", "10.00"]);
    await issueCreditNote(db, business.id, user, {
      invoiceId: partlyCredited.id,
      lines: [{ invoiceLineId: partlyCredited.lines[0].id, amountMinor: 1000 }],
    });
    expect(await voidInvoice(db, business.id, user, partlyCredited.id)).toBeNull();

    const plain = await issued(["10.00"]);
    expect((await getInvoiceCredits(db, business.id, plain.id))!.canVoid).toBe(true);
    expect(await voidInvoice(db, business.id, user, plain.id)).not.toBeNull();
  });

  it("counts credit notes as negative revenue on their issue date", async () => {
    const scoped = await db
      .insert(schema.business)
      .values({ name: "Gamma", currency: "EUR", taxConfig: { standardRatePct: "21" } })
      .returning();
    const gamma = scoped[0];
    const gammaClient = await createClient(db, gamma.id, user, { name: "Initech", contacts: [] });
    const invoice = await issued(["100.00"], gamma.id, gammaClient.id);
    await markInvoicePaid(db, gamma.id, invoice.id);
    await issueCreditNote(db, gamma.id, user, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: invoice.lines[0].id, amountMinor: 2500 }],
    }, CREDITED);

    const all = await profitSummary(db, gamma.id);
    const eur = all.accrual.find((r) => r.currency === "EUR")!;
    // 12100 invoiced - 3025 credited
    expect(eur.incomeMinor).toBe(9075);
    const cash = all.cash.find((r) => r.currency === "EUR")!;
    expect(cash.incomeMinor).toBe(9075);

    // A range that ends before the credit note leaves it out.
    const june1to10 = await profitSummary(db, gamma.id, {
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-10T00:00:00Z"),
    });
    expect(june1to10.accrual.find((r) => r.currency === "EUR")!.incomeMinor).toBe(12100);
  });

  it("gives billed time back when a credit note closes the invoice", async () => {
    const project = (await createProject(db, business.id, user, {
      name: "Website",
      clientId: client.id,
      status: "active",
    })) as { id: string };
    const task = (await createTask(db, business.id, project.id, {
      title: "Build",
      status: "in_progress",
    })) as { id: string };
    await db
      .update(schema.client)
      .set({ defaultRateMinor: 6000, defaultRateCurrency: "EUR" })
      .where(eq(schema.client.id, client.id));
    await logManualEntry(db, business.id, user, {
      taskId: task.id,
      startedAt: new Date("2026-06-08T09:00:00Z"),
      durationSeconds: 3600,
      billable: true,
    });
    const draft = (await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "zero_rated",
    })) as { id: string };
    const generated = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId: draft.id,
      grouping: "person_rate",
    });
    expect(generated).toMatchObject({ ok: true });
    await issueInvoice(db, business.id, draft.id, ISSUED);
    const billed = () =>
      db
        .select({ id: schema.timeEntry.id })
        .from(schema.timeEntry)
        .where(
          and(
            eq(schema.timeEntry.taskId, task.id),
            isNotNull(schema.timeEntry.invoiceLineId),
          ),
        );
    expect(await billed()).toHaveLength(1);
    const result = await issueCreditNote(db, business.id, user, { invoiceId: draft.id }, CREDITED);
    expect(result.ok).toBe(true);
    expect(await billed()).toHaveLength(0);
    // The whole hours line keeps its breakdown and unit.
    if (!result.ok) return;
    const note = (await getCreditNote(db, business.id, result.creditNote.id))!;
    expect(note.lines[0]).toMatchObject({ quantity: expect.any(String), unitCode: "HUR" });
  });

  it("lays the PDF out as a credit note", () => {
    const data = buildCreditNotePdfData({
      creditNote: {
        number: "CN-2026-0007",
        currency: "EUR",
        issueDate: CREDITED,
        taxTreatment: "standard",
        taxRatePercent: "21",
        taxNote: null,
        buyerReference: "PO-9",
        subtotalMinor: 1000,
        taxMinor: 210,
        totalMinor: 1210,
        reason: "Wrong rate",
        lines: [{ description: "Design", quantity: null, unitPriceMinor: null, totalMinor: 1000 }],
      },
      invoiceNumber: "2026-0012",
      invoiceIssueDate: ISSUED,
      business: { name: "Alpha", address: null, vatNumber: null, iban: "DE89370400440532013000" },
      client: { name: "Northwind", address: null, companyNumber: null, vatNumber: null },
    });
    expect(data).toMatchObject({
      title: "Credit note CN-2026-0007",
      balanceCaption: "Amount Credited",
      creditsInvoiceLabel: "2026-0012 of 1 Jun 2026",
      dueDateLabel: null,
      notes: "Reason: Wrong rate",
      paymentLines: [],
      buyerReference: "PO-9",
    });
  });
});
