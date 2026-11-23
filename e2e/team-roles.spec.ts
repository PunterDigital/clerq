import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { DEMO_EMAIL, DEMO_STATE } from "./env";

// Role escalation (#5582): a manager may only invite people as a role whose
// permissions they all hold themselves. Before, the invite picker offered
// Admin to a manager, and accepting that invite from a second account gave
// them every permission. The demo account joins a second business as a
// manager for this spec only (its own business stays untouched), and the
// active-business pointer is put back afterwards.
test.use({ storageState: DEMO_STATE });

const tag = randomUUID().slice(0, 8);
const ownerId = `e2e-roles-owner-${tag}`;
const adminId = `e2e-roles-admin-${tag}`;
let demoUserId = "";
let businessId = "";
let previousActiveBusiness: string | null = null;

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
    const pointer = await db.query<{ business_id: string }>(
      `select business_id from user_active_business where user_id = $1`,
      [demoUserId],
    );
    previousActiveBusiness = pointer.rows[0]?.business_id ?? null;

    const biz = await db.query<{ id: string }>(
      `insert into business (name, currency) values ('Roles Studio', 'EUR') returning id`,
    );
    businessId = biz.rows[0].id;
    for (const [id, name] of [
      [ownerId, "Rhea Owner"],
      [adminId, "Ari Admin"],
    ]) {
      await db.query(
        `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)`,
        [id, name, `${id}@clerq.test`],
      );
    }
    await db.query(
      `insert into business_member (business_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'manager')`,
      [businessId, ownerId, adminId, demoUserId],
    );
    await db.query(
      `insert into business_role (business_id, name, permissions) values ($1, 'Clients only', $2), ($1, 'Keys and profit', $3)`,
      [
        businessId,
        JSON.stringify(["clients.view"]),
        JSON.stringify(["clients.view", "apiKeys.manage", "reports.viewProfit"]),
      ],
    );
    await db.query(
      `insert into user_active_business (user_id, business_id) values ($1, $2)
       on conflict (user_id) do update set business_id = excluded.business_id`,
      [demoUserId, businessId],
    );
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    if (previousActiveBusiness) {
      await db.query(`update user_active_business set business_id = $2 where user_id = $1`, [
        demoUserId,
        previousActiveBusiness,
      ]);
    } else {
      await db.query(`delete from user_active_business where user_id = $1`, [demoUserId]);
    }
    await db.query(`delete from business_invitation where business_id = $1`, [businessId]);
    await db.query(`delete from business_member where business_id = $1`, [businessId]);
    await db.query(`delete from business_role where business_id = $1`, [businessId]);
    await db.query(`delete from business where id = $1`, [businessId]);
    await db.query(`delete from "user" where id = any($1)`, [[ownerId, adminId]]);
  });
});

test("a manager's invite picker only offers roles within their own permissions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/settings/team");
  await expect(page.getByText("Invite a team member")).toBeVisible();
  await expect(page.getByText("Ari Admin")).toBeVisible();

  const picker = page.getByLabel("Role", { exact: true });
  const options = await picker.locator("option").allTextContents();
  expect(options).toEqual(["Manager", "Member", "Contractor", "Viewer", "Clients only"]);
  await expect(picker).toHaveValue("member");

  // A manager has no team.manageRoles, so member rows show badges, not pickers.
  await expect(page.locator("select")).toHaveCount(1);

  // Inviting within the manager's own set still works.
  const inviteEmail = `e2e-roles-invitee-${tag}@clerq.test`;
  await page.getByLabel("Email").fill(inviteEmail);
  await picker.selectOption({ label: "Clients only" });
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText(inviteEmail)).toBeVisible();
  await expect(page.getByText(/Clients only . expires/)).toBeVisible();

  // The server refuses what the picker no longer offers.
  const forged = await page.request.post("/api/trpc/team.invite", {
    data: { json: { email: `e2e-roles-forged-${tag}@clerq.test`, role: "admin" } },
  });
  expect(forged.status()).toBe(403);
  expect(await forged.text()).toContain("permissions you don't have yourself");

  expect(errors).toEqual([]);
});
