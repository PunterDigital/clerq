import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { addManualLine } from "@/modules/billing/generate";
import {
  createDraftInvoice,
  issueInvoice,
  updateInvoiceDetails,
} from "@/modules/billing/invoices";
import { createClient } from "@/modules/clients/service";

import { exportEinvoice } from "./service";

let pglite: PGlite;
let db: Db;
let business: { id: string };
let client: { id: string };
const user = "user-a";

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  [business] = await db
    .insert(schema.business)
    .values({
      name: "Studio Nord GmbH",
      currency: "EUR",
      taxConfig: { standardRatePct: "19", vatNumber: "DE123456789" },
      einvoicingEnabled: true,
      postalAddress: {
        street: "Hauptstraße 5",
        city: "Berlin",
        postcode: "10115",
        region: null,
        country: "DE",
      },
      iban: "DE89370400440532013000",
    })
    .returning();
  await db
    .insert(schema.user)
    .values([{ id: user, name: "Anna", email: "anna@nord.test" }]);
  client = await createClient(db, business.id, user, {
    name: "Lumen Labs B.V.",
    contacts: [],
    vatNumber: "NL812345678B01",
    buyerReference: "PO-1",
    postalAddress: {
      street: "Keizersgracht 100",
      city: "Amsterdam",
      postcode: "1015 AA",
      country: "NL",
    },
  });
});

afterAll(async () => {
  await pglite.close();
});

describe("exportEinvoice (#5040)", () => {
  it("exports an issued reverse-charge invoice and refuses its draft", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "reverse_charge",
    });
    const invoiceId = draft!.id;
    await addManualLine(db, business.id, {
      invoiceId,
      description: "Workshop",
      amountMajor: "900",
      unitCode: "DAY",
    });

    const before = await exportEinvoice(db, business.id, invoiceId);
    expect(before).toMatchObject({ ok: false });
    expect(before?.ok === false && before.missing).toContain(
      "Issue the invoice first: drafts can't be exported",
    );

    await updateInvoiceDetails(db, business.id, invoiceId, {
      issueDate: new Date("2026-06-11T00:00:00Z"),
      dueDate: new Date("2026-07-11T00:00:00Z"),
      periodStart: null,
      periodEnd: null,
    });
    const issued = await issueInvoice(db, business.id, invoiceId);
    expect(issued.ok).toBe(true);

    const result = await exportEinvoice(db, business.id, invoiceId);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const number = issued.ok ? issued.invoice.number : "";
    expect(result.filename).toBe(`einvoice-${number}.xml`);
    expect(result.xml).toContain(`<cbc:ID>${number}</cbc:ID>`);
    expect(result.xml).toContain("<cbc:BuyerReference>PO-1</cbc:BuyerReference>");
    expect(result.xml).toContain('<cbc:InvoicedQuantity unitCode="DAY">1</cbc:InvoicedQuantity>');
    expect(result.xml).toContain("<cbc:ID>AE</cbc:ID>");
    expect(result.xml).toContain(
      '<cbc:EndpointID schemeID="9944">NL812345678B01</cbc:EndpointID>',
    );
  });

  it("answers null for another business's invoice and lists the switch-off", async () => {
    const [other] = await db
      .insert(schema.business)
      .values({ name: "Other", currency: "EUR" })
      .returning();
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "zero_rated",
    });
    expect(await exportEinvoice(db, other.id, draft!.id)).toBeNull();

    await db
      .update(schema.business)
      .set({ einvoicingEnabled: false })
      .where(eq(schema.business.id, business.id));
    const off = await exportEinvoice(db, business.id, draft!.id);
    expect(off?.ok === false && off.missing).toContain(
      "Turn on e-invoicing in Settings -> E-invoicing",
    );
    await db
      .update(schema.business)
      .set({ einvoicingEnabled: true })
      .where(eq(schema.business.id, business.id));
  });
});
