import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import { getAuth } from "./auth";
import { getConsentRequest } from "./mcp/consent-request";

// #5579: the MCP authorize endpoint must never hand a code straight to a
// client's redirect URI. Anyone can register a client with any redirect URI,
// so a code without the consent page was one-click access to a business.
// These run the real Better Auth handler on PGlite.

const BASE = "http://localhost:3000";
const EVIL = "https://evil.example/cb";

let pglite: PGlite;
let db: Db;
let clientId = "";

function cookiesFrom(res: Response, jar: Map<string, string>) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; jar?: Map<string, string> } = {},
) {
  const headers = new Headers({ origin: BASE });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.jar?.size) headers.set("cookie", cookieHeader(init.jar));
  const res = await getAuth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    }),
  );
  if (init.jar) cookiesFrom(res, init.jar);
  return res;
}

async function signUp(email: string) {
  const jar = new Map<string, string>();
  const res = await call("/sign-up/email", {
    method: "POST",
    body: { email, password: "correct horse battery", name: email },
    jar,
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  return { jar, userId: user.id };
}

function authorizePath(extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: EVIL,
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  });
  return `/mcp/authorize?${q.toString()}`;
}

function consentCodeFrom(location: string) {
  const url = new URL(location, BASE);
  expect(url.pathname).toBe("/oauth/consent");
  const code = url.searchParams.get("consent_code");
  expect(code).toBeTruthy();
  return code!;
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-mcp-consent";
  process.env.BETTER_AUTH_URL ??= BASE;
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  // Registration is open, as MCP clients need: no session, any redirect URI,
  // any name.
  const res = await call("/mcp/register", {
    method: "POST",
    body: {
      redirect_uris: [EVIL],
      token_endpoint_auth_method: "none",
      client_name: "Claude",
    },
  });
  expect(res.status).toBeLessThan(300);
  ({ client_id: clientId } = (await res.json()) as { client_id: string });
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

describe("MCP authorize always asks for consent", () => {
  it.each([
    ["no prompt", {}],
    ["prompt=none", { prompt: "none" }],
    ["prompt=login", { prompt: "login" }],
    ["prompt=select_account", { prompt: "select_account" }],
  ])("signed in, %s: goes to the consent page, not the client", async (_, extra) => {
    const { jar } = await signUp(`victim-${Math.random()}@t.dev`);
    const res = await call(authorizePath(extra), { jar });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("evil.example");
    consentCodeFrom(location);
  });

  it("the consent page reads the app name and redirect host from the pending code", async () => {
    const { jar, userId } = await signUp("owner@t.dev");
    const res = await call(authorizePath(), { jar });
    const code = consentCodeFrom(res.headers.get("location") ?? "");

    expect(await getConsentRequest(code, userId)).toEqual({
      clientName: "Claude",
      redirectHost: "evil.example",
    });
    // Someone else's code, or a made-up one, shows nothing to approve.
    const other = await signUp("other@t.dev");
    expect(await getConsentRequest(code, other.userId)).toBeNull();
    expect(await getConsentRequest("not-a-code", userId)).toBeNull();
  });

  it("the code only reaches the client after the user clicks Authorize", async () => {
    const { jar } = await signUp("approver@t.dev");
    const res = await call(authorizePath(), { jar });
    const code = consentCodeFrom(res.headers.get("location") ?? "");

    const consent = await call("/oauth2/consent", {
      method: "POST",
      body: { accept: true, consent_code: code },
      jar,
    });
    expect(consent.status).toBe(200);
    const { redirectURI } = (await consent.json()) as { redirectURI: string };
    const back = new URL(redirectURI);
    expect(`${back.origin}${back.pathname}`).toBe(EVIL);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("xyz");
  });

  it("signed out: after signing in, the user still lands on the consent page", async () => {
    await signUp("later@t.dev");
    const jar = new Map<string, string>();
    const first = await call(authorizePath(), { jar });
    expect(first.status).toBe(302);
    expect(first.headers.get("location") ?? "").toContain("/sign-in");

    const signIn = await call("/sign-in/email", {
      method: "POST",
      body: { email: "later@t.dev", password: "correct horse battery" },
      jar,
    });
    const text = await signIn.text();
    const location = signIn.headers.get("location") ?? "";
    expect(`${location} ${text}`).not.toContain("evil.example");
    expect(`${location} ${text}`).toContain("/oauth/consent");
  });
});
