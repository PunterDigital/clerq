import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import { getDb, schema } from "@/db";

// Better Auth's MCP authorize endpoint only shows the consent page when the
// request itself asks for it (prompt=consent). Without it, a signed-in user
// is sent straight back to the client's redirect URI with an authorization
// code - and anyone can register a client with any redirect URI. So one
// crafted link handed the attacker an MCP token for the victim's business
// (#5579). Every authorize request is treated as prompt=consent: the code
// only leaves through /oauth/consent, after the user clicks Authorize. The
// query is also what the plugin saves for the after-sign-in resume, so a
// signed-out user lands on the consent page too.
export const forceMcpConsent = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/mcp/authorize") return;
  return { context: { query: { ...ctx.query, prompt: "consent" } } };
});

function createAuth() {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  return betterAuth({
    database: drizzleAdapter(getDb(), { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
    },
    hooks: { before: forceMcpConsent },
    plugins: [
      // Turns this instance into an OAuth 2.1 authorization server for the
      // MCP integration: discovery, dynamic client registration, the consent
      // screen, and bearer-token issue/validation all come from this plugin.
      // The MCP route (app/api/mcp) is the protected resource it guards.
      mcp({
        loginPage: "/sign-in",
        oidcConfig: {
          loginPage: "/sign-in",
          // Where an authenticated user approves a connecting MCP client.
          consentPage: "/oauth/consent",
          // MCP clients (Claude, etc.) self-register dynamically.
          allowDynamicClientRegistration: true,
        },
      }),
    ],
    // Google SSO is strictly optional (ESC-3): self-hosting must never
    // require a third-party account. It exists only when both env values
    // are present.
    socialProviders:
      googleClientId && googleClientSecret
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            },
          }
        : undefined,
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

// Lazy on purpose: next build (and the Docker builder stage) imports route
// modules without a DATABASE_URL. The instance is created on first request
// and fails loud there if the env is missing.
export function getAuth() {
  auth ??= createAuth();
  return auth;
}

export function isGoogleSsoEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export type Session = ReturnType<typeof getAuth>["$Infer"]["Session"];
