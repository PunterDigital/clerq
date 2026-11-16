import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Card #4912: a freelancer logs all his time on one task and writes what he
// did in each timesheet note. Generating lines must be able to carry those
// notes onto the invoice, and Replace must rebuild the line with them (his
// first attempt had them off, and Replace then looked like it did nothing).
// The client and its time go straight into the database: logging three
// entries through the UI would make this spec about the timesheet.
test.use({ storageState: DEMO_STATE });

const clientName = `Notes Client ${Date.now()}`;

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
    const demo = await db.query<{ user_id: string; business_id: string }>(
      `select m.user_id, m.business_id from business_member m
         join "user" u on u.id = m.user_id
         join business b on b.id = m.business_id
        where u.email = $1 and b.name = 'Studio Demo'`,
      [DEMO_EMAIL],
    );
    const { user_id: userId, business_id: businessId } = demo.rows[0];
    const client = await db.query<{ id: string }>(
      `insert into client (business_id, name, default_rate_minor, default_rate_currency)
       values ($1, $2, 2375, 'EUR') returning id`,
      [businessId, clientName],
    );
    const project = await db.query<{ id: string }>(
      `insert into project (business_id, client_id, name) values ($1, $2, 'Retainer') returning id`,
      [businessId, client.rows[0].id],
    );
    const task = await db.query<{ id: string }>(
      `insert into task (business_id, project_id, title) values ($1, $2, 'xWave - Invoice 14') returning id`,
      [businessId, project.rows[0].id],
    );
    // Inserted out of order: the line lists notes by when the time was logged.
    for (const [day, note] of [
      ["2026-10-21", "Release notes"],
      ["2026-10-20", "Fixed login redirect\nCode review"],
      ["2026-10-22", null],
    ]) {
      await db.query(
        `insert into time_entry (business_id, task_id, user_id, started_at, ended_at,
           duration_seconds, billable, rate_minor, rate_currency, note)
         values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour',
           3600, true, 2375, 'EUR', $5)`,
        [businessId, task.rows[0].id, userId, `${day}T09:00:00Z`, note],
      );
    }
  });
});

test("generated lines list the timesheet notes, and Replace rebuilds them", async ({ page }) => {
  await page.goto("/invoices/new");
  await page.getByLabel("Client").selectOption({ label: clientName });
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();

  const generate = page.getByRole("button", { name: "Generate lines" });
  const lineText = page.locator("li p.whitespace-pre-line");

  // Tom's first attempt: task list only.
  await page.getByLabel("List covered tasks in the description").check();
  await generate.click();
  await expect(page.getByText("Added 1 line", { exact: true })).toBeVisible();
  await expect(lineText).toHaveCount(1);
  expect(await lineText.innerText()).toBe("Demo Maker - 23.75 EUR/h (xWave - Invoice 14)");

  // Then the notes, replacing the line generated a moment ago.
  await page.getByLabel("List timesheet notes under each line").check();
  await page.getByLabel(/Replace lines generated earlier/).check();
  await generate.click();
  await expect(
    page.getByText("Replaced the generated lines - 1 line now", { exact: true }),
  ).toBeVisible();
  await expect(lineText).toHaveCount(1);
  await expect(lineText).toContainText("Release notes");
  expect(await lineText.innerText()).toBe(
    [
      "Demo Maker - 23.75 EUR/h (xWave - Invoice 14)",
      "- Fixed login redirect",
      "- Code review",
      "- Release notes",
    ].join("\n"),
  );
  await expect(page.getByText("3.00 h x € 23.75/h")).toBeVisible();
});
