import { readFileSync } from "node:fs";

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "@cantoo/pdf-lib";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Card #5040: an issued invoice downloads as a Peppol BIS 3.0 UBL e-invoice,
// and one that can't be exported yet says what to add. The business is set
// up for e-invoicing in the database (a German seller) and put back after;
// the invoices are inserted already issued, because issuing isn't what this
// spec is about. Card #5041: the same invoice's PDF is a Factur-X
// PDF/A-3b with factur-x.xml inside; the others are plain PDF/A-3b.
test.use({ storageState: DEMO_STATE });
test.describe.configure({ mode: "serial" });

const stamp = Date.now();
let businessId = "";
let readyInvoiceId = "";
let missingInvoiceId = "";
let before: Record<string, unknown> | null = null;

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function issuedInvoice(
  db: Client,
  clientId: string,
  number: string,
  buyerReference: string | null,
): Promise<string> {
  const inv = await db.query<{ id: string }>(
    `insert into invoice (business_id, client_id, status, number, year, currency, issue_date,
       due_date, tax_treatment, tax_rate_percent, tax_note, vatex_code, buyer_reference,
       subtotal_minor, tax_minor, total_minor)
     values ($1, $2, 'sent', $3, 2099, 'EUR', '2099-01-15', '2099-02-14', 'reverse_charge', '0',
       'VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC',
       'VATEX-EU-AE', $4, 32667, 0, 32667)
     returning id`,
    [businessId, clientId, number, buyerReference],
  );
  await db.query(
    `insert into invoice_line (business_id, invoice_id, position, description, quantity,
       unit_price_minor, total_minor, unit_code)
     values ($1, $2, 1, 'Consulting', '4.083333', 8000, 32667, 'HUR')`,
    [businessId, inv.rows[0].id],
  );
  return inv.rows[0].id;
}

// Clicks "Download PDF" and reads the file back: the XMP metadata and the
// files in the catalog's /AF array (name, relationship, XML).
async function downloadPdf(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const download = await downloadPromise;
  const doc = await PDFDocument.load(readFileSync((await download.path()) as string), {
    updateMetadata: false,
  });
  const text = (ref: unknown) => {
    const stream = doc.context.lookup(ref as never);
    if (!(stream instanceof PDFRawStream)) throw new Error("not a stream");
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  };
  const af = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  const files = (af?.asArray() ?? []).map((ref) => {
    const spec = doc.context.lookup(ref, PDFDict);
    return {
      name: spec.lookup(PDFName.of("F"))?.toString(),
      relationship: spec.get(PDFName.of("AFRelationship"))?.toString(),
      xml: text(spec.lookup(PDFName.of("EF"), PDFDict).get(PDFName.of("F"))),
    };
  });
  return {
    filename: download.suggestedFilename(),
    xmp: text(doc.catalog.get(PDFName.of("Metadata"))),
    files,
  };
}

test.beforeAll(async () => {
  await withDb(async (db) => {
    const demo = await db.query<{ business_id: string }>(
      `select m.business_id from business_member m
         join "user" u on u.id = m.user_id
         join business b on b.id = m.business_id
        where u.email = $1 and b.name = 'Studio Demo'`,
      [DEMO_EMAIL],
    );
    businessId = demo.rows[0].business_id;
    const row = await db.query(
      `select einvoicing_enabled, postal_address, tax_config, iban, bic, einvoice_contact
         from business where id = $1`,
      [businessId],
    );
    before = row.rows[0];
    await db.query(
      `update business set einvoicing_enabled = true,
         postal_address = $2,
         tax_config = coalesce(tax_config, '{}'::jsonb) || '{"vatNumber": "DE123456789"}'::jsonb,
         iban = 'DE89370400440532013000'
       where id = $1`,
      [
        businessId,
        JSON.stringify({ street: "Hauptstraße 5", city: "Berlin", postcode: "10115", region: null, country: "DE" }),
      ],
    );
    const ready = await db.query<{ id: string }>(
      `insert into client (business_id, name, vat_number, postal_address)
       values ($1, $2, 'NL812345678B01', $3) returning id`,
      [
        businessId,
        `Lumen Labs ${stamp}`,
        JSON.stringify({ street: "Keizersgracht 100", city: "Amsterdam", postcode: "1015 AA", region: null, country: "NL" }),
      ],
    );
    const bare = await db.query<{ id: string }>(
      `insert into client (business_id, name) values ($1, $2) returning id`,
      [businessId, `Bare Client ${stamp}`],
    );
    readyInvoiceId = await issuedInvoice(db, ready.rows[0].id, `2099-${String(stamp).slice(-4)}`, "PO-7781");
    missingInvoiceId = await issuedInvoice(
      db,
      bare.rows[0].id,
      `2099-${String(stamp + 1).slice(-4)}`,
      null,
    );
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.query(`delete from invoice where id = any($1::uuid[])`, [
      [readyInvoiceId, missingInvoiceId].filter(Boolean),
    ]);
    if (before) {
      await db.query(
        `update business set einvoicing_enabled = $2, postal_address = $3, tax_config = $4,
           iban = $5, bic = $6, einvoice_contact = $7 where id = $1`,
        [
          businessId,
          before.einvoicing_enabled,
          before.postal_address == null ? null : JSON.stringify(before.postal_address),
          JSON.stringify(before.tax_config ?? {}),
          before.iban,
          before.bic,
          before.einvoice_contact == null ? null : JSON.stringify(before.einvoice_contact),
        ],
      );
    }
  });
});

test("an issued invoice downloads as a Peppol BIS 3.0 e-invoice", async ({ page }) => {
  await page.goto(`/invoices/${readyInvoiceId}`);
  await expect(page.getByLabel("Missing for the e-invoice")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download e-invoice (XML)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^einvoice-2099-\d{4}\.xml$/);
  const xml = readFileSync((await download.path()) as string, "utf8");
  expect(xml).toContain(
    "<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>",
  );
  expect(xml).toContain("<cbc:BuyerReference>PO-7781</cbc:BuyerReference>");
  expect(xml).toContain('<cbc:InvoicedQuantity unitCode="HUR">4.083333</cbc:InvoicedQuantity>');
  expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">326.67</cbc:PayableAmount>');
});

test("its PDF is a Factur-X invoice with the same data", async ({ page }) => {
  await page.goto(`/invoices/${readyInvoiceId}`);
  const pdf = await downloadPdf(page);
  expect(pdf.filename).toMatch(/^invoice-2099-\d{4}\.pdf$/);
  expect(pdf.xmp).toContain("<pdfaid:part>3</pdfaid:part>");
  expect(pdf.xmp).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>");
  expect(pdf.files).toHaveLength(1);
  expect(pdf.files[0].name).toBe("(factur-x.xml)");
  expect(pdf.files[0].relationship).toBe("/Alternative");
  const xml = pdf.files[0].xml;
  expect(xml).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
  expect(xml).toContain("<ram:BuyerReference>PO-7781</ram:BuyerReference>");
  expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">4.083333</ram:BilledQuantity>');
  expect(xml).toContain("<ram:DuePayableAmount>326.67</ram:DuePayableAmount>");
});

test("one that can't be exported lists what to add, and offers no download", async ({ page }) => {
  await page.goto(`/invoices/${missingInvoiceId}`);
  const list = page.getByLabel("Missing for the e-invoice");
  await expect(list).toBeVisible();
  await expect(list).toContainText(`Bare Client ${stamp}'s address in parts`);
  await expect(list).toContainText("A buyer reference / PO number on the invoice");
  await expect(page.getByRole("link", { name: "Download e-invoice (XML)" })).toHaveCount(0);

  // The download URL itself refuses with the same list.
  const res = await page.request.get(`/api/invoices/${missingInvoiceId}/einvoice`);
  expect(res.status()).toBe(422);
  expect(await res.text()).toContain("A buyer reference / PO number on the invoice");

  // Its PDF is still PDF/A-3b, without Factur-X.
  const pdf = await downloadPdf(page);
  expect(pdf.xmp).toContain("<pdfaid:part>3</pdfaid:part>");
  expect(pdf.xmp).not.toContain("fx:");
  expect(pdf.files).toEqual([]);
});

test("with e-invoicing off there's neither a button nor a list", async ({ page }) => {
  await withDb((db) =>
    db.query(`update business set einvoicing_enabled = false where id = $1`, [businessId]),
  );
  await page.goto(`/invoices/${readyInvoiceId}`);
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download e-invoice (XML)" })).toHaveCount(0);
  await expect(page.getByLabel("Missing for the e-invoice")).toHaveCount(0);
  expect((await downloadPdf(page)).files).toEqual([]);
});
