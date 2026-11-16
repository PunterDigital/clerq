import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Support impersonation (#4910): a platform admin views the app as a customer
// to diagnose a problem, read-only, and stops again. The demo account is made
// a platform admin for this spec only, and the customer is inserted straight
// into the database: impersonation never needs their password, and a sign-up
// would cost one of Better Auth's 3 sign-ins per 10 s.
test.use({ storageState: DEMO_STATE });

const customerId = `e2e-customer-${randomUUID()}`;
const customerName = "Carla Customer";
const customerEmail = `${customerId}@clerq.test`;
const customerClient = `Carla's Client ${Date.now()}`;
let demoUserId = "";
let businessId = "";

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
    const demo = await db.query<{ id: string }>(`select id from "user" where email = $1`, [
      DEMO_EMAIL,
    ]);
    demoUserId = demo.rows[0].id;
    await db.query(
      `insert into platform_admin (user_id) values ($1) on conflict do nothing`,
      [demoUserId],
    );
    await db.query(
      `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)`,
      [customerId, customerName, customerEmail],
    );
    const biz = await db.query<{ id: string }>(
      `insert into business (name, currency) values ('Carla Studio', 'EUR') returning id`,
    );
    businessId = biz.rows[0].id;
    await db.query(
      `insert into business_member (business_id, user_id, role) values ($1, $2, 'owner')`,
      [businessId, customerId],
    );
    await db.query(`insert into client (business_id, name) values ($1, $2)`, [
      businessId,
      customerClient,
    ]);
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.query(`delete from impersonation where target_user_id = $1`, [customerId]);
    await db.query(`delete from client where business_id = $1`, [businessId]);
    await db.query(`delete from business_member where business_id = $1`, [businessId]);
    await db.query(`delete from business where id = $1`, [businessId]);
    await db.query(`delete from "user" where id = $1`, [customerId]);
    await db.query(`delete from platform_admin where user_id = $1`, [demoUserId]);
  });
});

test("support impersonation: view as a customer read-only, then stop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`/system-admin/users/${customerId}`);
  await expect(page.getByRole("heading", { name: customerName })).toBeVisible();
  await expect(page.getByText("No one has viewed as this user.")).toBeVisible();

  // A reason is required before it starts.
  await page.getByRole("button", { name: "View as this user" }).click();
  const startButton = page.getByRole("button", { name: "Start viewing" });
  await expect(startButton).toBeDisabled();
  await page.getByLabel("Reason (kept in the audit history)").fill("E2E ticket: missing client");
  await startButton.click();

  // Every page now renders as the customer, under the banner.
  await expect(page).toHaveURL(/\/$/);
  const banner = page.getByTestId("impersonation-banner");
  await expect(banner).toContainText(`Viewing as ${customerName}`);
  await expect(banner).toContainText("Read-only");

  await page.goto("/clients");
  await expect(page.getByText(customerClient)).toBeVisible();
  // The demo business's own seeded clients aren't there.
  await expect(page.getByText("Northwind")).toHaveCount(0);

  // Changes are refused.
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill("Should not be created");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByText("Read-only while viewing as another user")).toBeVisible();
  await expect(page).toHaveURL(/\/clients\/new$/);

  // The data export is off, and System Administration isn't reachable as them.
  const exportResponse = await page.request.get("/api/export");
  expect(exportResponse.status()).toBe(403);
  await page.goto("/system-admin");
  await expect(page).not.toHaveURL(/system-admin/);

  // Stop: back on the user's admin page as the admin, with the visit recorded.
  await page.getByRole("button", { name: "Stop viewing" }).click();
  await expect(page).toHaveURL(new RegExp(`/system-admin/users/${customerId}$`));
  await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);
  const history = page.getByTestId("impersonation-history");
  await expect(history).toContainText("Demo Maker");
  await expect(history).toContainText("E2E ticket: missing client");

  await withDb(async (db) => {
    const created = await db.query(`select 1 from client where name = 'Should not be created'`);
    expect(created.rowCount).toBe(0);
  });

  expect(errors).toEqual([]);
});
