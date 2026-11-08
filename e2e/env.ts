// Values the Playwright web server is started with that specs assert on.
export const E2E_VERSION = "999.0.0-e2e";

// The OpenRouter stand-in (e2e/openrouter-stub.mjs) that "Scan with AI" talks
// to during E2E.
export const OPENROUTER_STUB_PORT = Number(
  process.env.OPENROUTER_STUB_PORT ?? 3199,
);

// The demo account `pnpm db:seed` creates (db/seed.ts); it owns its business.
export const DEMO_EMAIL = "demo@clerq.local";
export const DEMO_PASSWORD = "clerq-demo";
// Its signed-in session, saved once by e2e/auth.setup.ts.
export const DEMO_STATE = "playwright/.auth/demo.json";
