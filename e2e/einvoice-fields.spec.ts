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
      `select postal_address, einvoicing_enabled, iban, bic from business where id = $1`,
      [businessId],
    );
    businessBefore = before.rows[0];
    await db.query(
      `update business set einvoicing_enabled = true, iban = null, bic = null,
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
        `update business set postal_address = $2, einvoicing_enabled = $3, iban = $4, bic = $5
          where id = $1`,
        [
          businessId,
          businessBefore.postal_address == null
            ? null
            : JSON.stringify(businessBefore.postal_address),
          businessBefore.einvoicing_enabled,
          businessBefore.iban,
          businessBefore.bic,
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
  await save.click();
  await expect(page.getByText("E-invoicing is on")).toBeVisible();

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

  await page.goto("/settings");
  await expect(page.getByLabel("IBAN", { exact: true })).toHaveCount(0);
});
