import { expect, test, type Page } from "@playwright/test";

// The demo account `pnpm db:seed` creates (db/seed.ts).
const DEMO_EMAIL = "demo@clerq.local";
const DEMO_PASSWORD = "clerq-demo";

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

test("a signed-out visitor is sent to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("wrong password is refused", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("core flow: browse the seeded business and add a client", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page);

  for (const [path, heading] of [
    ["/clients", "Clients"],
    ["/projects", "Projects"],
    ["/time", "Timesheet"],
    ["/invoices", "Invoices"],
    ["/expenses", "Expenses"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }

  await page.goto("/clients");
  await expect(page.getByText("Northwind Studio s.r.o.").first()).toBeVisible();
  await page.goto("/projects");
  await expect(page.getByText("Website rebuild").first()).toBeVisible();

  const name = `E2E Client ${Date.now()}`;
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page).toHaveURL(/\/clients\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await page.goto("/clients");
  await expect(page.getByText(name)).toBeVisible();

  expect(errors).toEqual([]);
});
