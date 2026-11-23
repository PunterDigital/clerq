import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// An expense's receipt is served by its own route (#5693): the page shows it
// lazily from /api/expenses/[id]/receipt and no longer carries the base64
// data URL in its HTML. The expense is inserted straight into the database
// with a known PNG and removed afterwards.
test.use({ storageState: DEMO_STATE });

// A 2x2 red PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=";

let expenseId = "";

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
    const biz = await db.query<{ business_id: string }>(
      `select bm.business_id from business_member bm join "user" u on u.id = bm.user_id
        where u.email = $1 order by bm.created_at limit 1`,
      [DEMO_EMAIL],
    );
    const row = await db.query<{ id: string }>(
      `insert into expense (business_id, description, amount_minor, currency, incurred_at,
                            receipt_data_url, receipt_filename, receipt_mime_type)
       values ($1, 'E2E receipt route', 1234, 'EUR', now(), $2, 'e2e-receipt.png', 'image/png')
       returning id`,
      [biz.rows[0].business_id, `data:image/png;base64,${PNG_BASE64}`],
    );
    expenseId = row.rows[0].id;
  });
});

test.afterAll(async () => {
  await withDb((db) => db.query(`delete from expense where id = $1`, [expenseId]));
});

test("the expense page shows the receipt from its route; Open and Download work", async ({
  page,
  context,
}) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });

  const res = await page.goto(`/expenses/${expenseId}`);
  const html = await res!.text();
  expect(html).not.toContain(PNG_BASE64);
  expect(html).toContain(`/api/expenses/${expenseId}/receipt`);

  const image = page.getByRole("img", { name: "e2e-receipt.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(2);

  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Open" }).click(),
  ]);
  await popup.waitForLoadState();
  expect(popup.url()).toContain(`/api/expenses/${expenseId}/receipt`);
  await popup.close();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("e2e-receipt.png");
  const saved = await download.path();
  expect(saved).toBeTruthy();

  expect(violations).toEqual([]);
});
