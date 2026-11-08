import { expect, test as setup } from "@playwright/test";

import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_STATE } from "./env";

// Signs the demo account in once and saves the session for the specs that
// only need to be signed in (test.use({ storageState: DEMO_STATE })). Better
// Auth allows 3 sign-ins per 10 seconds per IP in production builds, and the
// smoke spec signs in twice on its own (wrong password, then the core flow).
setup("sign in as the demo account", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.context().storageState({ path: DEMO_STATE });
});
