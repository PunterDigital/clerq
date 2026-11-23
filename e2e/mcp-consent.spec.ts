import { expect, test } from "@playwright/test";

import { DEMO_STATE } from "./env";

// #5579: an MCP client's authorization code only comes back after the user
// approves on the consent page, whatever the authorize link says, and the
// page names the app and the host it sends the user back to (from the
// database, not the link).
test.use({ storageState: DEMO_STATE });

test("MCP connect: consent page first, code only after Authorize", async ({
  page,
  playwright,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // A real MCP client registers without any cookies (the shared `request`
  // fixture carries the demo session, which Better Auth's origin check then
  // refuses without an Origin header).
  const client = await playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const callback = `${baseURL}/e2e-oauth-callback`;
  const registered = await client.post("/api/auth/mcp/register", {
    data: {
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      client_name: "E2E MCP client",
    },
  });
  expect(registered.status(), await registered.text()).toBeLessThan(300);
  const { client_id } = (await registered.json()) as { client_id: string };
  await client.dispose();

  const authorize = new URLSearchParams({
    client_id,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "e2e-state",
    // The old behaviour: anything but prompt=consent skipped the page.
    prompt: "none",
  });
  await page.goto(`/api/auth/mcp/authorize?${authorize.toString()}`);

  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(page.getByText("E2E MCP client")).toBeVisible();
  const host = new URL(callback).host;
  await expect(page.getByTestId("consent-redirect")).toContainText(host);

  // A client_name in the link changes nothing: the name comes from the DB.
  const spoofed = new URL(page.url());
  spoofed.searchParams.set("client_name", "Claude");
  await page.goto(spoofed.toString());
  await expect(page.getByText("E2E MCP client")).toBeVisible();
  await expect(page.getByText("Claude", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Authorize" }).click();
  await expect(page).toHaveURL(/\/e2e-oauth-callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get("code")).toBeTruthy();
  expect(back.searchParams.get("state")).toBe("e2e-state");

  // A made-up code has nothing to approve.
  await page.goto("/oauth/consent?consent_code=not-a-real-code&client_id=x");
  await expect(page.getByText("This request has expired")).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
