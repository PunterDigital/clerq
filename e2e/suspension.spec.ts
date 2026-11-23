import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Suspensions take effect on the next request (#5694: the layout and the
// page's tRPC calls now share one check per render, and that must not mean
// a stale answer on the next page load). The rows are written straight to
// the database, as a platform admin's suspend would, and always removed.
test.use({ storageState: DEMO_STATE });
test.describe.configure({ mode: "serial" });

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
    const demo = await db.query<{ id: string; business_id: string }>(
      `select u.id, bm.business_id from "user" u
         join business_member bm on bm.user_id = u.id
        where u.email = $1
        order by bm.created_at limit 1`,
      [DEMO_EMAIL],
    );
    demoUserId = demo.rows[0].id;
    businessId = demo.rows[0].business_id;
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.query(`delete from user_suspension where user_id = $1`, [demoUserId]);
    await db.query(`delete from business_suspension where business_id = $1`, [businessId]);
  });
});

test("a suspended account sees the notice on the next page load, and the app once lifted", async ({
  page,
}) => {
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();

  await withDb((db) =>
    db.query(
      `insert into user_suspension (user_id, suspended_at, reason) values ($1, now(), 'E2E check')`,
      [demoUserId],
    ),
  );
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Your account has been suspended" })).toBeVisible();
  await expect(page.getByText("E2E check")).toBeVisible();

  await withDb((db) => db.query(`delete from user_suspension where user_id = $1`, [demoUserId]));
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
});

test("a suspended business shows its notice on the next page load", async ({ page }) => {
  await withDb((db) =>
    db.query(
      `insert into business_suspension (business_id, suspended_at, reason) values ($1, now(), null)`,
      [businessId],
    ),
  );
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "This business has been suspended" })).toBeVisible();

  await withDb((db) =>
    db.query(`delete from business_suspension where business_id = $1`, [businessId]),
  );
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Invoices", exact: true })).toBeVisible();
});
