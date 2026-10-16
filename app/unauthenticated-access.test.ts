import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

// The unauthenticated-access boundary for the whole HTTP surface: every URL an
// anonymous visitor could type must either be intentionally public or refuse
// them. Two enforcement styles exist and both are exercised here against the
// real code (PGlite via the getDb() seam, real route handlers, real layouts):
//
//   - Pages are gated by their route-group layout, which redirects to /sign-in
//     when there is no session. This is what stops an anonymous visitor from
//     viewing an expense's receipt, which is embedded (as a data URL) inside
//     the gated /expenses/[expenseId] page - there is no separate receipt URL.
//   - API routes that stream a file (invoice PDF, data export) or speak MCP
//     answer a cookieless request with 401 rather than a redirect.
//
// A structural pass then proves the two live checks above actually cover the
// entire app/ tree: every page.tsx and route.ts is classified, so a newly
// added route that slips outside the auth boundary fails this suite instead of
// shipping unprotected.

// The gated layouts read `await headers()`, which needs Next's per-request
// AsyncLocalStorage that vitest has no scope for. Hand them an empty header bag
// so the code path under test - the session lookup and its redirect - runs.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

// `server-only` is a build-time guard that throws unless resolved by an RSC
// bundler; it has no runtime behaviour. The (app) layout pulls it in via the
// tRPC server caller, so stub it to a no-op to let the module import here.
vi.mock("server-only", () => ({}));

// The app/ directory this test lives in, for the structural coverage pass.
const appDir = fileURLToPath(new URL("./", import.meta.url));

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
  // getAuth() builds its Drizzle adapter against getDb(); the PDF-link verifier
  // and the discovery/MCP endpoints read these two env values. None of the
  // anonymous paths asserted here touch a session row, but a migrated DB keeps
  // the auth instance honest regardless of what better-auth probes.
  process.env.BETTER_AUTH_SECRET ??= "test-secret-unauthenticated-access";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

// A thrown Next redirect carries a `NEXT_REDIRECT;<type>;<url>;<status>;`
// digest. Assert the layout/page bounces an anonymous caller to `to` rather
// than rendering anything.
async function expectRedirect(
  run: () => Promise<unknown>,
  to: string,
): Promise<void> {
  let digest: unknown;
  try {
    await run();
  } catch (err) {
    digest = (err as { digest?: unknown }).digest;
  }
  expect(digest, "expected a redirect to be thrown").toBeTypeOf("string");
  expect(digest).toContain("NEXT_REDIRECT");
  expect(digest).toContain(to);
}

describe("file-download routes refuse anonymous requests", () => {
  it("serves no invoice PDF without a session or token", async () => {
    const { GET } = await import("@/app/api/invoices/[invoiceId]/pdf/route");
    const res = await GET(
      new Request("http://localhost/api/invoices/inv-1/pdf"),
      { params: Promise.resolve({ invoiceId: "inv-1" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in first");
  });

  it("rejects a forged PDF link token instead of streaming the PDF", async () => {
    const { GET } = await import("@/app/api/invoices/[invoiceId]/pdf/route");
    // A guessed/tampered token must never resolve to a business - otherwise a
    // leaked link shape could be repointed at someone else's invoice.
    const res = await GET(
      new Request("http://localhost/api/invoices/inv-1/pdf?token=forged.token"),
      { params: Promise.resolve({ invoiceId: "inv-1" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid or expired link");
  });

  it("exports no business data without a session", async () => {
    const { GET } = await import("@/app/api/export/route");
    const res = await GET(new Request("http://localhost/api/export"));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in first");
  });

  it("serves no expense-receipts zip without a session", async () => {
    const { GET } = await import("@/app/api/expenses/receipts/route");
    const res = await GET(
      new Request(
        "http://localhost/api/expenses/receipts?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z",
      ),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in first");
  });

  it("rejects an MCP call that carries no bearer token", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("the cron trigger refuses anonymous callers", () => {
  it("is disabled (404) until a token is configured, and never runs the sweep", async () => {
    const original = process.env.CLERQ_CRON_TOKEN;
    try {
      delete process.env.CLERQ_CRON_TOKEN;
      const { POST } = await import("@/app/api/cron/run/route");
      const res = await POST(
        new Request("http://localhost/api/cron/run", { method: "POST" }),
      );
      expect(res.status).toBe(404);
    } finally {
      if (original === undefined) delete process.env.CLERQ_CRON_TOKEN;
      else process.env.CLERQ_CRON_TOKEN = original;
    }
  });

  it("rejects a missing or wrong bearer token with 401 once configured", async () => {
    const original = process.env.CLERQ_CRON_TOKEN;
    try {
      process.env.CLERQ_CRON_TOKEN = "secret-cron-token";
      const { POST } = await import("@/app/api/cron/run/route");

      const noHeader = await POST(
        new Request("http://localhost/api/cron/run", { method: "POST" }),
      );
      expect(noHeader.status).toBe(401);

      const wrongToken = await POST(
        new Request("http://localhost/api/cron/run", {
          method: "POST",
          headers: { authorization: "Bearer not-the-token" },
        }),
      );
      expect(wrongToken.status).toBe(401);
    } finally {
      if (original === undefined) delete process.env.CLERQ_CRON_TOKEN;
      else process.env.CLERQ_CRON_TOKEN = original;
    }
  });
});

describe("gated pages redirect anonymous visitors to sign-in", () => {
  it("bounces the signed-in app shell (clients, invoices, expenses+receipts, settings...)", async () => {
    const { default: AppLayout } = await import("@/app/(app)/layout");
    await expectRedirect(
      () => AppLayout({ children: null }),
      "/sign-in",
    );
  });

  it("bounces the system-admin console", async () => {
    const { default: SystemAdminLayout } = await import(
      "@/app/system-admin/layout"
    );
    await expectRedirect(
      () => SystemAdminLayout({ children: null }),
      "/sign-in",
    );
  });

  it("bounces the onboarding screen", async () => {
    const { default: OnboardingPage } = await import("@/app/onboarding/page");
    await expectRedirect(() => OnboardingPage(), "/sign-in");
  });
});

describe("public routes stay reachable without a session", () => {
  it("serves OAuth protected-resource discovery metadata", async () => {
    // Positive control: "unauthenticated" is not "everything is blocked" - the
    // discovery endpoint an MCP client hits before it has a token is public.
    const { GET } = await import(
      "@/app/.well-known/oauth-protected-resource/route"
    );
    const res = await GET(
      new Request("http://localhost/.well-known/oauth-protected-resource"),
    );
    expect(res.status).toBe(200);
  });

  it("serves the running version", async () => {
    const { GET } = await import("@/app/version/route");
    expect(GET().status).toBe(200);
  });
});

// -- Structural coverage: prove the live checks above span the whole tree. ----

// Every page.tsx / route.ts under app/, path relative to app/ with "/" seps.
function filesEndingWith(suffix: string): string[] {
  return readdirSync(appDir, { recursive: true })
    .map(String)
    .map((p) => p.split(sep).join("/"))
    .filter((p) => p.endsWith(suffix))
    .sort();
}

// Pages whose auth story is verified by the redirect tests above.
const GATED_PAGE_PREFIXES = ["(app)/", "system-admin/"];
const SELF_GATED_PAGES = ["onboarding/page.tsx"];
// Pages that are public by design - login/registration, the OAuth consent
// screen (the OAuth flow itself gates it), and the invite screen, which shows
// only a business name and branches to sign-in for anonymous visitors.
const PUBLIC_PAGES = [
  "(auth)/sign-in/page.tsx",
  "(auth)/sign-up/page.tsx",
  "(auth)/oauth/consent/page.tsx",
  "invite/[token]/page.tsx",
];

// Routes whose anonymous behaviour is asserted by the live tests above.
const PROTECTED_ROUTES = [
  "api/invoices/[invoiceId]/pdf/route.ts",
  "api/expenses/receipts/route.ts",
  "api/export/route.ts",
  "api/mcp/route.ts",
  // The recurring-invoice cron trigger: token-guarded, not session-gated. It
  // stays disabled (404) until CLERQ_CRON_TOKEN is set, and refuses a wrong or
  // missing bearer token with 401 - never runs the sweep for an anonymous
  // caller.
  "api/cron/run/route.ts",
];
// The tRPC entrypoint is public, but every procedure behind it gates on a
// session (see server/trpc/routers/auth-boundary.test.ts).
const PER_PROCEDURE_ROUTES = ["api/trpc/[trpc]/route.ts"];
// Public by design: the Better Auth handler (sign-in/up, OAuth), the two
// RFC discovery documents MCP clients read before authenticating, and the
// running version (no data, used to verify deploys).
const PUBLIC_ROUTES = [
  "api/auth/[...all]/route.ts",
  ".well-known/oauth-authorization-server/route.ts",
  ".well-known/oauth-protected-resource/route.ts",
  "version/route.ts",
];

describe("every URL in the app is accounted for", () => {
  it("classifies every page as gated, self-gated, or intentionally public", () => {
    const pages = filesEndingWith("page.tsx");
    const known = new Set([...SELF_GATED_PAGES, ...PUBLIC_PAGES]);
    const unclassified = pages.filter(
      (p) =>
        !GATED_PAGE_PREFIXES.some((prefix) => p.startsWith(prefix)) &&
        !known.has(p),
    );
    // A new page.tsx outside a gated group must be given an explicit auth story
    // (add it to a gated group, or acknowledge it as public) rather than
    // silently shipping without one.
    expect(unclassified, `unclassified pages: ${unclassified.join(", ")}`).toEqual(
      [],
    );

    // Sanity: the gated groups aren't empty, so the redirect tests are real.
    const gated = pages.filter((p) =>
      GATED_PAGE_PREFIXES.some((prefix) => p.startsWith(prefix)),
    );
    expect(gated.length).toBeGreaterThanOrEqual(10);
  });

  it("classifies every API/well-known route", () => {
    const routes = filesEndingWith("route.ts");
    const known = new Set([
      ...PROTECTED_ROUTES,
      ...PER_PROCEDURE_ROUTES,
      ...PUBLIC_ROUTES,
    ]);
    const unclassified = routes.filter((r) => !known.has(r));
    expect(
      unclassified,
      `unclassified routes: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("exposes no unaccounted receipt URL - receipts live in the gated expense page or the session-gated zip route", () => {
    // Receipts are stored as base64 data URLs and rendered client-side inside
    // /expenses/[expenseId] (a gated page). The one standalone receipt route -
    // the period zip download - answers anonymous requests with 401 (asserted
    // live above). Any other receipt-serving route.ts needs its own auth check
    // and its own test - fail until then.
    const receiptRoutes = filesEndingWith("route.ts").filter((r) =>
      r.toLowerCase().includes("receipt"),
    );
    expect(receiptRoutes).toEqual(["api/expenses/receipts/route.ts"]);
    // And the expense detail page that embeds them is under the gated group.
    const expensePages = filesEndingWith("page.tsx").filter((p) =>
      p.includes("expenses/[expenseId]"),
    );
    expect(expensePages.length).toBeGreaterThan(0);
    for (const page of expensePages) {
      expect(page.startsWith("(app)/")).toBe(true);
    }
  });
});
