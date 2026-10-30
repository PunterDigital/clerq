import { expect, test, type Page } from "@playwright/test";

// The demo account `pnpm db:seed` creates (db/seed.ts); it owns its business.
const DEMO_EMAIL = "demo@clerq.local";
const DEMO_PASSWORD = "clerq-demo";

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

test("API keys: create one, use it, revoke it", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page);
  await page.goto("/settings");
  await page.getByRole("link", { name: "API", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api$/);

  const name = `E2E key ${Date.now()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Access").selectOption("write");
  await page.getByRole("button", { name: "Create key" }).click();

  const shown = page.getByTestId("new-api-key");
  await expect(shown).toBeVisible();
  const key = (await shown.textContent())?.trim() ?? "";
  expect(key).toMatch(/^clq_[A-Za-z0-9_-]{40,}$/);

  const row = page.getByTestId("api-key-row").filter({ hasText: name });
  await expect(row).toContainText("Read and write");
  await expect(row).toContainText("never used");
  await expect(row).toContainText(key.slice(0, 12));

  // Use it: the health endpoint answers as the demo business.
  const ok = await request.get("/api/v1/health", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body).toMatchObject({ status: "ok", key: { name, scope: "write" } });
  expect(body.business.name).toBeTruthy();

  // Without a key, or on a path with no endpoint, the API answers in JSON.
  const anon = await request.get("/api/v1/health");
  expect(anon.status()).toBe(401);
  expect(await anon.json()).toMatchObject({ error: { code: "unauthorized" } });
  const missing = await request.get("/api/v1/nope", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(missing.status()).toBe(404);

  // After a reload the key is gone from the page, and the use is recorded.
  await page.reload();
  await expect(page.getByTestId("new-api-key")).toHaveCount(0);
  await expect(page.getByText(key)).toHaveCount(0);
  await expect(row).toContainText("last used");

  // Revoke it: the next request is refused.
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Confirm revoke" }).click();
  await page.getByText(/Revoked keys/).click();
  await expect(row).toContainText("revoked");
  await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  const revoked = await request.get("/api/v1/health", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(revoked.status()).toBe(401);

  expect(errors).toEqual([]);
});
