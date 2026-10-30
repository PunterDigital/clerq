import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

import { schema, type Db } from "@/db";
import type { ApiKeyPrincipal } from "@/server/trpc/init";

// Per-business API keys (the api_key table). A key is 32 random bytes behind a
// recognisable prefix, so a leaked one is easy to spot in logs and secret
// scanners. It is high-entropy, so a plain SHA-256 is the right store: a slow
// password hash buys nothing against 256 random bits and would cost a
// key-derivation on every API request.

export const API_KEY_PREFIX = "clq_";

// How many characters of the key the list shows ("clq_" plus 8).
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

// last_used_at is written at most this often per key, so a busy script does
// not turn every read into a write.
const LAST_USED_RESOLUTION_MS = 60_000;

export type ApiKeyScope = "read" | "write";

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

// The bearer token from an Authorization header, or null.
export function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

export async function createApiKey(
  db: Db,
  input: { businessId: string; userId: string; name: string; scope: ApiKeyScope },
): Promise<{ id: string; key: string }> {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(schema.apiKey)
    .values({
      businessId: input.businessId,
      userId: input.userId,
      name: input.name,
      scope: input.scope,
      keyPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
      keyHash: hashApiKey(key),
    })
    .returning({ id: schema.apiKey.id });
  return { id: row.id, key };
}

export type ApiKeySummary = {
  id: string;
  name: string;
  scope: ApiKeyScope;
  keyPrefix: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

// Every key of the business, newest first, revoked ones included so the list
// shows what was turned off and when.
export async function listApiKeys(
  db: Db,
  businessId: string,
): Promise<ApiKeySummary[]> {
  return db
    .select({
      id: schema.apiKey.id,
      name: schema.apiKey.name,
      scope: schema.apiKey.scope,
      keyPrefix: schema.apiKey.keyPrefix,
      createdBy: schema.user.name,
      createdAt: schema.apiKey.createdAt,
      lastUsedAt: schema.apiKey.lastUsedAt,
      revokedAt: schema.apiKey.revokedAt,
    })
    .from(schema.apiKey)
    .innerJoin(schema.user, eq(schema.apiKey.userId, schema.user.id))
    .where(eq(schema.apiKey.businessId, businessId))
    .orderBy(desc(schema.apiKey.createdAt));
}

// Revokes a live key of the business. False when there is no such live key
// (wrong id, another business's key, or already revoked).
export async function revokeApiKey(
  db: Db,
  businessId: string,
  keyId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKey.id, keyId),
        eq(schema.apiKey.businessId, businessId),
        isNull(schema.apiKey.revokedAt),
      ),
    )
    .returning({ id: schema.apiKey.id });
  return rows.length > 0;
}

export type VerifiedApiKey = ApiKeyPrincipal & { userId: string; name: string };

// Resolves a presented key to its live row, or null for an unknown or revoked
// key. Records the use (at most once a minute per key).
export async function verifyApiKey(
  db: Db,
  plaintext: string,
): Promise<VerifiedApiKey | null> {
  if (!looksLikeApiKey(plaintext)) return null;
  const [row] = await db
    .select({
      id: schema.apiKey.id,
      businessId: schema.apiKey.businessId,
      userId: schema.apiKey.userId,
      name: schema.apiKey.name,
      scope: schema.apiKey.scope,
    })
    .from(schema.apiKey)
    .where(
      and(
        eq(schema.apiKey.keyHash, hashApiKey(plaintext)),
        isNull(schema.apiKey.revokedAt),
      ),
    );
  if (!row) return null;

  const now = new Date();
  await db
    .update(schema.apiKey)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(schema.apiKey.id, row.id),
        or(
          isNull(schema.apiKey.lastUsedAt),
          lt(
            schema.apiKey.lastUsedAt,
            new Date(now.getTime() - LAST_USED_RESOLUTION_MS),
          ),
        ),
      ),
    );
  return row;
}
