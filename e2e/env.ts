// Values the Playwright web server is started with that specs assert on.
export const E2E_VERSION = "999.0.0-e2e";

// The OpenRouter stand-in (e2e/openrouter-stub.mjs) that "Scan with AI" talks
// to during E2E.
export const OPENROUTER_STUB_PORT = Number(
  process.env.OPENROUTER_STUB_PORT ?? 3199,
);
