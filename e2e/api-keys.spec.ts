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

// The tests share one signed-in page: Better Auth allows 3 sign-ins per 10
// seconds per IP in production builds, and the smoke spec signs in right after.
test.describe.configure({ mode: "serial" });

let page: Page;
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("API keys: create one, use it, revoke it", async ({ request }) => {
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
});

async function createKey(scope: "read" | "write"): Promise<string> {
  await page.goto("/settings/api");
  await page.getByLabel("Name").fill(`E2E ${scope} ${Date.now()}`);
  await page.getByLabel("Access").selectOption(scope);
  await page.getByRole("button", { name: "Create key" }).click();
  const shown = page.getByTestId("new-api-key");
  await expect(shown).toBeVisible();
  return (await shown.textContent())?.trim() ?? "";
}

test("REST API: clients, projects and tasks made with a key show up in the app", async ({
  request,
}) => {
  const writeKey = await createKey("write");
  const readKey = await createKey("read");
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
});

test("REST API: a timer started with a key runs in the app, and manual time is logged", async ({
  request,
}) => {
  const key = await createKey("write");
  const as = { authorization: `Bearer ${key}` };
  const stamp = Date.now();

  const client = await request.post("/api/v1/clients", {
    headers: as,
    data: { name: `Timer client ${stamp}` },
  });
  const project = await request.post("/api/v1/projects", {
    headers: as,
    data: { name: `Timer project ${stamp}`, clientId: (await client.json()).id },
  });
  const projectId = (await project.json()).id;
  const task = await request.post("/api/v1/tasks", {
    headers: as,
    data: { projectId, title: `Timer task ${stamp}` },
  });
  const taskId = (await task.json()).id;

  const started = await request.post("/api/v1/timer/start", {
    headers: as,
    data: { taskId },
  });
  expect(started.status()).toBe(201);
  const running = await request.get("/api/v1/timer", { headers: as });
  expect((await running.json()).timer).toMatchObject({ taskId });

  // The key acts as the demo user, so the app shows that user's timer running.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();

  const stopped = await request.post("/api/v1/timer/stop", { headers: as });
  expect((await stopped.json()).entry).toMatchObject({ taskId });
  await page.reload();
  await expect(page.getByRole("button", { name: "Start timer on this task" })).toBeVisible();

  const logged = await request.post("/api/v1/time-entries", {
    headers: as,
    data: { taskId, startedAt: "2026-01-05T09:00:00Z", durationSeconds: 5400, note: "From the API" },
  });
  expect(logged.status()).toBe(201);
  const entryId = (await logged.json()).id;
  const january = await request.get("/api/v1/time-entries?from=2026-01-05&to=2026-01-06", {
    headers: as,
  });
  expect((await january.json()).data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: entryId, note: "From the API", taskTitle: `Timer task ${stamp}` }),
    ]),
  );
  const removed = await request.delete(`/api/v1/time-entries/${entryId}`, { headers: as });
  expect(removed.status()).toBe(200);
});
