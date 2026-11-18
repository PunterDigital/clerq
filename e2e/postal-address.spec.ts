import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Card #5038: structured addresses for e-invoicing. A client that only has a
// free-text address gets a suggested split it can take with one click; the
// business settings get the same fields. The free text stays what the PDF
// prints. The client goes straight into the database: what matters here is
// an existing row from before the feature.
test.use({ storageState: DEMO_STATE });

const clientName = `Postal Client ${Date.now()}`;
const freeText = "12 Harbour Street\nBristol BS1 4QA\nUnited Kingdom";
let clientId = "";
let businessId = "";
let businessBefore: { address: string | null; postal_address: unknown } | null = null;

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
    const before = await db.query<{ address: string | null; postal_address: unknown }>(
      `select address, postal_address from business where id = $1`,
      [businessId],
    );
    businessBefore = before.rows[0];
    const client = await db.query<{ id: string }>(
      `insert into client (business_id, name, address) values ($1, $2, $3) returning id`,
      [businessId, clientName, freeText],
    );
    clientId = client.rows[0].id;
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    if (businessBefore) {
      await db.query(
        `update business set address = $2, postal_address = $3 where id = $1`,
        [
          businessId,
          businessBefore.address,
          businessBefore.postal_address == null
            ? null
            : JSON.stringify(businessBefore.postal_address),
        ],
      );
    }
  });
});

async function postalFields(page: Page) {
  return {
    street: await page.getByLabel("Street", { exact: true }).inputValue(),
    city: await page.getByLabel("City", { exact: true }).inputValue(),
    postcode: await page.getByLabel("Postcode", { exact: true }).inputValue(),
    country: await page.getByLabel("Country", { exact: true }).inputValue(),
  };
}

test("an existing client takes the suggested split of its address", async ({ page }) => {
  await page.goto(`/clients/${clientId}/edit`);
  const suggestion = page.getByTestId("address-suggestion");
  await expect(suggestion).toContainText(
    "12 Harbour Street · BS1 4QA Bristol · United Kingdom",
  );
  // Nothing is filled in until the user takes it.
  expect(await postalFields(page)).toEqual({ street: "", city: "", postcode: "", country: "" });

  await suggestion.getByRole("button", { name: "Use this" }).click();
  await expect(suggestion).toBeHidden();
  expect(await postalFields(page)).toEqual({
    street: "12 Harbour Street",
    city: "Bristol",
    postcode: "BS1 4QA",
    country: "GB",
  });

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`));

  const row = await withDb((db) =>
    db.query<{ address: string; postal_address: unknown }>(
      `select address, postal_address from client where id = $1`,
      [clientId],
    ),
  );
  expect(row.rows[0].address).toBe(freeText);
  expect(row.rows[0].postal_address).toEqual({
    street: "12 Harbour Street",
    city: "Bristol",
    postcode: "BS1 4QA",
    region: null,
    country: "GB",
  });

  await page.goto(`/clients/${clientId}/edit`);
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("Bristol");
  await expect(page.getByTestId("address-suggestion")).toHaveCount(0);
});

test("a partly filled structured address needs a country", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill(`No Country ${Date.now()}`);
  await page.getByLabel("City", { exact: true }).fill("Lisbon");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByText("Pick a country for the structured address")).toBeVisible();
  await expect(page).toHaveURL(/\/clients\/new$/);
});

test("the business settings save a structured address", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Street", { exact: true }).fill("Hauptstraße 5");
  await page.getByLabel("City", { exact: true }).fill("Berlin");
  await page.getByLabel("Postcode", { exact: true }).fill("10115");
  await page.getByLabel("Country", { exact: true }).selectOption("DE");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const row = await withDb((db) =>
        db.query<{ postal_address: { city?: string; country?: string } | null }>(
          `select postal_address from business where id = $1`,
          [businessId],
        ),
      );
      return row.rows[0].postal_address;
    })
    .toMatchObject({ city: "Berlin", country: "DE" });

  await page.reload();
  await expect(page.getByLabel("Street", { exact: true })).toHaveValue("Hauptstraße 5");
  await expect(page.getByLabel("Country", { exact: true })).toHaveValue("DE");
});
