import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests against the production build. Expects a migrated and
// seeded database (pnpm db:migrate && pnpm db:seed) and a finished
// `pnpm build`; CI does both before `pnpm test:e2e`. Point DATABASE_URL at a
// throwaway database - the tests create records.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The standalone server the Docker image runs, minus the image: Next
    // leaves static assets and public/ for the deployer to copy in.
    command: `node scripts/e2e-server.mjs`,
    url: `${baseURL}/sign-in`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "e2e-only-secret-not-used-anywhere-real",
      // The scheduler and update checker have nothing to do in a smoke test.
      CLERQ_DISABLE_SCHEDULER: "1",
    },
  },
});
