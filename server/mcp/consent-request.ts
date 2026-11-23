import { and, eq, gt } from "drizzle-orm";

import { getDb, schema } from "@/db";

// What the consent page shows about a pending MCP authorization (#5579).
// Everything comes from the database, never from the page's query string:
// the client name is what the client registered (anyone can register any
// name, so the page also shows where the code will be sent), and the
// redirect host is the one saved with this exact pending code.
export type ConsentRequest = {
  clientName: string;
  redirectHost: string;
};

type PendingCode = {
  clientId?: unknown;
  redirectURI?: unknown;
  userId?: unknown;
  requireConsent?: unknown;
};

export async function getConsentRequest(
  consentCode: string,
  userId: string,
): Promise<ConsentRequest | null> {
  const db = getDb();
  const [row] = await db
    .select({ value: schema.verification.value })
    .from(schema.verification)
    .where(
      and(
        eq(schema.verification.identifier, consentCode),
        gt(schema.verification.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;

  let pending: PendingCode;
  try {
    pending = JSON.parse(row.value) as PendingCode;
  } catch {
    return null;
  }
  if (
    pending.requireConsent !== true ||
    pending.userId !== userId ||
    typeof pending.clientId !== "string" ||
    typeof pending.redirectURI !== "string"
  ) {
    return null;
  }

  let redirectHost: string;
  try {
    redirectHost = new URL(pending.redirectURI).host || pending.redirectURI;
  } catch {
    return null;
  }

  const [client] = await db
    .select({ name: schema.oauthApplication.name })
    .from(schema.oauthApplication)
    .where(eq(schema.oauthApplication.clientId, pending.clientId))
    .limit(1);
  if (!client) return null;

  return { clientName: client.name, redirectHost };
}
