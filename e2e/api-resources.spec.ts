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

async function createKey(page: Page, scope: "read" | "write"): Promise<string> {
  await page.goto("/settings/api");
  await page.getByLabel("Name").fill(`E2E ${scope} ${Date.now()}`);
  await page.getByLabel("Access").selectOption(scope);
  await page.getByRole("button", { name: "Create key" }).click();
  const shown = page.getByTestId("new-api-key");
  await expect(shown).toBeVisible();
  return (await shown.textContent())?.trim() ?? "";
}

test("REST API: clients, projects and tasks made with a key show up in the app", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page);
  const writeKey = await createKey(page, "write");
  const readKey = await createKey(page, "read");
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  const stamp = Date.now();

  const client = await request.post("/api/v1/clients", {
    headers: as(writeKey),
    data: { name: `API client ${stamp}`, contacts: [{ name: "Jo API" }] },
  });
  expect(client.status()).toBe(201);
  const clientId = (await client.json()).id;

  const renamed = await request.patch(`/api/v1/clients/${clientId}`, {
    headers: as(writeKey),
    data: { name: `API client renamed ${stamp}` },
  });
  expect(renamed.status()).toBe(200);
  expect(await renamed.json()).toMatchObject({ contacts: [{ name: "Jo API" }] });

  const project = await request.post("/api/v1/projects", {
    headers: as(writeKey),
    data: { name: `API project ${stamp}`, clientId, dueDate: "2027-01-15" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id;

  const task = await request.post("/api/v1/tasks", {
    headers: as(writeKey),
    data: { projectId, title: `API task ${stamp}`, estimateMinutes: 45 },
  });
  expect(task.status()).toBe(201);
  const taskId = (await task.json()).id;
  const status = await request.post(`/api/v1/tasks/${taskId}/status`, {
    headers: as(writeKey),
    data: { status: "in_progress" },
  });
  expect(await status.json()).toMatchObject({ status: "in_progress" });

  // A read-only key can list but not write.
  const listed = await request.get(`/api/v1/tasks?projectId=${projectId}`, {
    headers: as(readKey),
  });
  expect((await listed.json()).data).toEqual([
    expect.objectContaining({ id: taskId, title: `API task ${stamp}` }),
  ]);
  const refused = await request.post("/api/v1/clients", {
    headers: as(readKey),
    data: { name: "Nope" },
  });
  expect(refused.status()).toBe(403);

  // The app shows what the API made.
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByText(`API client renamed ${stamp}`).first()).toBeVisible();
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText(`API project ${stamp}`).first()).toBeVisible();
  await expect(page.getByText(`API task ${stamp}`).first()).toBeVisible();

  // Deleting through the API removes it from the project page.
  const deleted = await request.delete(`/api/v1/tasks/${taskId}`, {
    headers: as(writeKey),
  });
  expect(deleted.status()).toBe(200);
  await page.reload();
  await expect(page.getByText(`API task ${stamp}`)).toHaveCount(0);

  expect(errors).toEqual([]);
});
