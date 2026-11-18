import { readFileSync } from "node:fs";

import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Card #5042: an issued invoice is corrected with a credit note (its own
// number, CN- prefix by default), partly or in full. Void stays only for
// invoices that never went out as an e-invoice. The invoices are inserted
// already issued; the spec removes them, their credit notes and the client
// afterwards, and puts the credit note prefix back.
test.use({ storageState: DEMO_STATE });
test.describe.configure({ mode: "serial" });

const stamp = Date.now();
let businessId = "";
let clientId = "";
let plainInvoiceId = "";
let sentInvoiceId = "";
let prefixBefore = "CN-";

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

// A sent 21% VAT invoice with the given line amounts (minor units).
async function issuedInvoice(
  db: Client,
  number: string,
  lines: number[],
  einvoiceSent: boolean,
): Promise<string> {
  const subtotal = lines.reduce((a, b) => a + b, 0);
  const tax = Math.round(subtotal * 0.21);
  const inv = await db.query<{ id: string }>(
    `insert into invoice (business_id, client_id, status, number, year, currency, issue_date,
       due_date, tax_treatment, tax_rate_percent, subtotal_minor, tax_minor, total_minor,
       einvoice_sent_at)
     values ($1, $2, 'sent', $3, 2099, 'EUR', '2099-01-15', '2099-02-14', 'standard', '21',
       $4, $5, $6, $7)
     returning id`,
    [businessId, clientId, number, subtotal, tax, subtotal + tax, einvoiceSent ? new Date() : null],
  );
  for (const [i, total] of lines.entries()) {
    await db.query(
      `insert into invoice_line (business_id, invoice_id, position, description, total_minor)
       values ($1, $2, $3, $4, $5)`,
      [businessId, inv.rows[0].id, i + 1, `Work item ${i + 1}`, total],
    );
  }
  return inv.rows[0].id;
}

async function issueFromDialog(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "Issue credit note" }).click();
  await expect(page).toHaveURL(/\/invoices\/credit-notes\/[0-9a-f-]{36}$/);
}

test.beforeAll(async () => {
  await withDb(async (db) => {
    const demo = await db.query<{ business_id: string; credit_note_prefix: string }>(
      `select m.business_id, b.credit_note_prefix from business_member m
         join "user" u on u.id = m.user_id
         join business b on b.id = m.business_id
        where u.email = $1 and b.name = 'Studio Demo'`,
      [DEMO_EMAIL],
    );
    businessId = demo.rows[0].business_id;
    prefixBefore = demo.rows[0].credit_note_prefix;
    const client = await db.query<{ id: string }>(
      `insert into client (business_id, name) values ($1, $2) returning id`,
      [businessId, `Credit Client ${stamp}`],
    );
    clientId = client.rows[0].id;
    plainInvoiceId = await issuedInvoice(db, `2099-C${String(stamp).slice(-4)}`, [10000, 5000], false);
    sentInvoiceId = await issuedInvoice(db, `2099-E${String(stamp).slice(-4)}`, [20000], true);
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    const ids = [plainInvoiceId, sentInvoiceId].filter(Boolean);
    await db.query(`delete from credit_note where invoice_id = any($1::uuid[])`, [ids]);
    await db.query(`delete from invoice where id = any($1::uuid[])`, [ids]);
    if (clientId) {
      await db.query(`delete from activity where client_id = $1`, [clientId]);
      await db.query(`delete from client where id = $1`, [clientId]);
    }
    if (businessId) {
      await db.query(`update business set credit_note_prefix = $2 where id = $1`, [
        businessId,
        prefixBefore,
      ]);
    }
  });
});

test("a partial credit note, then the rest, closes the invoice as credited", async ({ page }) => {
  await page.goto(`/invoices/${plainInvoiceId}`);
  // Never sent as an e-invoice and not credited yet: Void is still offered.
  await expect(page.getByRole("button", { name: "Void invoice" })).toBeVisible();

  await page.getByRole("button", { name: "Issue credit note" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Work item 1", { exact: true })).toHaveValue("100.00");
  await expect(dialog.getByLabel("Work item 2", { exact: true })).toHaveValue("50.00");
  await dialog.getByLabel("Credit Work item 2").uncheck();
  await dialog.getByLabel("Work item 1", { exact: true }).fill("40.00");
  await expect(dialog.getByText("Credit: € 40.00 plus VAT at 21%")).toBeVisible();
  await dialog.getByLabel("Reason (printed on the credit note)").fill("Wrong rate");
  await issueFromDialog(page);

  const first = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  expect(first).toMatch(/^CN-\d{4}-\d{4}$/);
  await expect(page.getByText("Reason: Wrong rate")).toBeVisible();
  // 40.00 + 21% VAT
  await expect(page.getByText("€ 48.40")).toBeVisible();

  // The PDF is a PDF/A credit note named after its number.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`credit-note-${first}.pdf`);
  const doc = await PDFDocument.load(readFileSync((await download.path()) as string), {
    updateMetadata: false,
  });
  const xmpStream = doc.context.lookup(doc.catalog.get(PDFName.of("Metadata")) as never);
  const xmp = new TextDecoder().decode(
    decodePDFRawStream(xmpStream as PDFRawStream).decode(),
  );
  expect(xmp).toContain(`Credit note ${first}`);
  expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");

  // Back on the invoice: listed, deducted, and no longer voidable.
  await page.getByRole("link", { name: /^invoice 2099-C/ }).click();
  await expect(page.getByLabel("Credit notes").getByRole("link", { name: first })).toBeVisible();
  await expect(page.getByText("-€ 48.40").first()).toBeVisible();
  // 181.50 - 48.40
  await expect(page.getByText("€ 133.10")).toBeVisible();
  await expect(page.getByRole("button", { name: "Void invoice" })).toHaveCount(0);

  // The rest: everything left stays ticked, so it's a full credit.
  await page.getByRole("button", { name: "Issue credit note" }).click();
  await expect(page.getByRole("dialog").getByLabel("Work item 1", { exact: true })).toHaveValue("60.00");
  await issueFromDialog(page);
  const second = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  expect(second).not.toBe(first);
  await expect(page.getByText("€ 133.10")).toBeVisible();

  await page.goto(`/invoices/${plainInvoiceId}`);
  await expect(page.getByText("Credited", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue credit note" })).toHaveCount(0);

  // Both on the Credit notes tab and on the client's thread.
  await page.goto("/invoices/credit-notes");
  await expect(page.getByRole("link", { name: new RegExp(first) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(second) })).toBeVisible();
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByText("Credit note issued")).toHaveCount(2);
});

test("an invoice sent as an e-invoice can't be voided, and the prefix comes from Settings", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Credit note prefix").fill("CR/");
  await page.getByRole("button", { name: "Save prefix" }).click();
  await expect(page.getByText(/Credit notes have their own numbers: CR\/\d{4}-0001/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Credit note prefix")).toHaveValue("CR/");

  await page.goto(`/invoices/${sentInvoiceId}`);
  await expect(page.getByText("Sent as an e-invoice, so it can't be voided")).toBeVisible();
  await expect(page.getByRole("button", { name: "Void invoice" })).toHaveCount(0);
  await page.getByRole("button", { name: "Issue credit note" }).click();
  await issueFromDialog(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^CR\/\d{4}-\d{4}$/);
  // 200.00 + 21% VAT
  await expect(page.getByText("€ 242.00")).toBeVisible();
});
