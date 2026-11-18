import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Card #5039: the fields e-invoices need beyond the address. With
// e-invoicing on: IBAN/BIC in Settings (checked), a buyer reference / PO
// number on the client that each new invoice starts with and can change,
// a VATEX code on the draft, and a unit per line. The business's opt-in
// state is set in the database and put back afterwards; postal-address.spec
// covers switching it on through the UI. The tests build on each other.
test.use({ storageState: DEMO_STATE });
test.describe.configure({ mode: "serial" });

const clientName = `PO Client ${Date.now()}`;
let businessId = "";
let clientId = "";
let invoiceId = "";
let businessBefore: {
  postal_address: unknown;
  einvoicing_enabled: boolean;
  iban: string | null;
  bic: string | null;
  einvoice_contact: unknown;
  peppol_id: string | null;
  company_number: string | null;
  company_number_scheme: string | null;
} | null = null;

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
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
    const before = await db.query<NonNullable<typeof businessBefore>>(
      `select postal_address, einvoicing_enabled, iban, bic, einvoice_contact,
              peppol_id, company_number, company_number_scheme
         from business where id = $1`,
      [businessId],
    );
    businessBefore = before.rows[0];
    await db.query(
      `update business set einvoicing_enabled = true, iban = null, bic = null,
         peppol_id = null, company_number = null, company_number_scheme = null,
         postal_address = $2 where id = $1`,
      [
        businessId,
        JSON.stringify({
          street: "Hauptstraße 5",
          city: "Berlin",
          postcode: "10115",
          country: "DE",
        }),
      ],
    );
    const client = await db.query<{ id: string }>(
      `insert into client (business_id, name) values ($1, $2) returning id`,
      [businessId, clientName],
    );
    clientId = client.rows[0].id;
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    if (businessBefore) {
      await db.query(
        `update business set postal_address = $2, einvoicing_enabled = $3, iban = $4, bic = $5,
           einvoice_contact = $6, peppol_id = $7, company_number = $8,
           company_number_scheme = $9 where id = $1`,
        [
          businessId,
          businessBefore.postal_address == null
            ? null
            : JSON.stringify(businessBefore.postal_address),
          businessBefore.einvoicing_enabled,
          businessBefore.iban,
          businessBefore.bic,
          businessBefore.einvoice_contact == null
            ? null
            : JSON.stringify(businessBefore.einvoice_contact),
          businessBefore.peppol_id,
          businessBefore.company_number,
          businessBefore.company_number_scheme,
        ],
      );
    }
  });
});

test("Settings checks and saves the IBAN and BIC", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByLabel("Enable e-invoicing")).toBeChecked();
  const iban = page.getByLabel("IBAN", { exact: true });
  const bic = page.getByLabel("BIC", { exact: true });
  const save = page.getByRole("button", { name: "Save e-invoicing" });

  await iban.fill("DE89 3704 0044 0532 0130 01");
  await save.click();
  await expect(page.getByText("That IBAN doesn't look right")).toBeVisible();

  await iban.fill("de89 3704 0044 0532 0130 00");
  await bic.fill("cobadeffxxx");
  // Seller contact for e-invoices (#5040).
  await page.getByLabel("Contact name").fill("Anna Nord");
  await page.getByLabel("Phone", { exact: true }).fill("+49 30 1234567");
  await page.getByLabel("Email", { exact: true }).fill("billing@studio-nord.example");
  await save.click();
  await expect(page.getByText("E-invoicing is on")).toBeVisible();
  const contact = await withDb((db) =>
    db.query<{ einvoice_contact: unknown }>(
      `select einvoice_contact from business where id = $1`,
      [businessId],
    ),
  );
  expect(contact.rows[0].einvoice_contact).toEqual({
    name: "Anna Nord",
    phone: "+49 30 1234567",
    email: "billing@studio-nord.example",
  });

  await page.reload();
  await expect(page.getByLabel("IBAN", { exact: true })).toHaveValue(
    "DE89 3704 0044 0532 0130 00",
  );
  await expect(page.getByLabel("BIC", { exact: true })).toHaveValue("COBADEFFXXX");
  const row = await withDb((db) =>
    db.query<{ iban: string; bic: string }>(`select iban, bic from business where id = $1`, [
      businessId,
    ]),
  );
  expect(row.rows[0]).toEqual({ iban: "DE89370400440532013000", bic: "COBADEFFXXX" });
});

test("the client's buyer reference is the default on a new invoice, which can override it", async ({
  page,
}) => {
  await page.goto(`/clients/${clientId}/edit`);
  await page
    .getByLabel("Buyer reference / PO number (optional)")
    .fill("04011000-1234512345-06");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`));

  await page.goto("/invoices/new");
  await page.getByLabel("Client").selectOption({ label: clientName });
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();
  invoiceId = page.url().split("/").pop() ?? "";

  const reference = page.getByLabel("Buyer reference / PO number");
  await expect(reference).toHaveValue("04011000-1234512345-06");
  await reference.fill("PO-7781");
  await page.getByLabel("VAT exemption code (VATEX)").selectOption("VATEX-EU-AE");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText(/ - PO PO-7781/)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Buyer reference / PO number")).toHaveValue("PO-7781");
  await expect(page.getByLabel("VAT exemption code (VATEX)")).toHaveValue("VATEX-EU-AE");

  // The client keeps its own default.
  await page.goto(`/clients/${clientId}/edit`);
  await expect(
    page.getByLabel("Buyer reference / PO number (optional)"),
  ).toHaveValue("04011000-1234512345-06");
});

test("a fixed line starts as C62 and its unit can be changed on the draft", async ({ page }) => {
  await page.goto(`/invoices/${invoiceId}`);
  await page.getByLabel("Description", { exact: true }).fill("Workshop");
  await page.getByLabel(/^Amount/).fill("900");
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByText("Unit: Units (fixed amount) (C62)")).toBeVisible();

  await page.getByRole("button", { name: "Edit line" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Unit").selectOption("DAY");
  await dialog.getByRole("button", { name: "Save line" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Unit: Days (DAY)")).toBeVisible();
});

// Card #5075: an explicit Peppol ID on the business and the client, and the
// business's company number with its register.
test("Settings and the client form save a Peppol ID and the company number", async ({ page }) => {
  await page.goto("/settings");
  const save = page.getByRole("button", { name: "Save e-invoicing" });
  const scheme = page.getByLabel("Peppol ID scheme");
  const number = page.getByLabel("Peppol ID number");

  // A scheme without a number is refused before anything is saved.
  await scheme.selectOption("0204");
  await save.click();
  await expect(page.getByText("A Peppol ID needs both a scheme and a number")).toBeVisible();

  await number.fill("991-1234512345-06");
  await page.getByLabel("Company number", { exact: true }).fill("HRB 4711");
  await page.getByLabel("Company register").selectOption("0246");
  await save.click();
  await expect(page.getByText("E-invoicing is on")).toBeVisible();
  const saved = await withDb((db) =>
    db.query<{ peppol_id: string; company_number: string; company_number_scheme: string }>(
      `select peppol_id, company_number, company_number_scheme from business where id = $1`,
      [businessId],
    ),
  );
  expect(saved.rows[0]).toEqual({
    peppol_id: "0204:991-1234512345-06",
    company_number: "HRB 4711",
    company_number_scheme: "0246",
  });

  await page.reload();
  await expect(page.getByLabel("Peppol ID scheme")).toHaveValue("0204");
  await expect(page.getByLabel("Peppol ID number")).toHaveValue("991-1234512345-06");
  await expect(page.getByLabel("Company number", { exact: true })).toHaveValue("HRB 4711");
  await expect(page.getByLabel("Company register")).toHaveValue("0246");

  // The client: a Danish CVR-based Peppol ID.
  await page.goto(`/clients/${clientId}/edit`);
  await page.getByLabel("Peppol ID scheme").selectOption("0184");
  await page.getByLabel("Peppol ID number").fill("12 34");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("That Peppol ID number doesn't look right")).toBeVisible();
  await page.getByLabel("Peppol ID number").fill("29403473");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`));
  const client = await withDb((db) =>
    db.query<{ peppol_id: string }>(`select peppol_id from client where id = $1`, [clientId]),
  );
  expect(client.rows[0].peppol_id).toBe("0184:29403473");
  await page.goto(`/clients/${clientId}/edit`);
  await expect(page.getByLabel("Peppol ID scheme")).toHaveValue("0184");
  await expect(page.getByLabel("Peppol ID number")).toHaveValue("29403473");
});

test("with e-invoicing off none of these fields show", async ({ page }) => {
  await withDb((db) =>
    db.query(`update business set einvoicing_enabled = false where id = $1`, [businessId]),
  );
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();
  await expect(page.getByLabel("Buyer reference / PO number")).toHaveCount(0);
  await expect(page.getByLabel("VAT exemption code (VATEX)")).toHaveCount(0);
  await expect(page.getByText(/^Unit: /)).toHaveCount(0);
  // The PO number the draft already has still shows (and prints).
  await expect(page.getByText(/ - PO PO-7781/)).toBeVisible();

  await page.goto(`/clients/${clientId}/edit`);
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Buyer reference / PO number (optional)")).toHaveCount(0);
  await expect(page.getByLabel("Peppol ID scheme")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByLabel("IBAN", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Peppol ID scheme")).toHaveCount(0);
  await expect(page.getByLabel("Company register")).toHaveCount(0);
});
