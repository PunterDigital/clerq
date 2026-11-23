import { createHmac, timingSafeEqual } from "node:crypto";

// Short-lived, signed download links for invoice PDFs. An MCP client can't
// carry the browser session cookie the PDF route normally requires, so the
// `get_invoice_pdf_link` tool hands back a URL bearing one of these tokens.
// The token is an HMAC over {invoiceId, businessId, exp}: tamper-evident,
// self-expiring, and scoped to the business the caller actually belongs to,
// so it can never widen access beyond what the tool already granted.

const DEFAULT_TTL_SECONDS = 15 * 60;

export type InvoicePdfTokenPayload = {
  invoiceId: string;
  businessId: string;
  /** Unix epoch seconds after which the token is rejected. */
  exp: number;
  /**
   * Whether fetching a PDF that carries Factur-X may mark the invoice as
   * sent (un-voidable). True only when the minting caller could void it
   * (#5583); missing in older tokens, which then never mark.
   */
  markSent?: boolean;
};

type SignOptions = {
  secret?: string;
  ttlSeconds?: number;
  /** Injectable clock (ms since epoch) - real callers use Date.now(). */
  nowMs?: number;
};

type VerifyOptions = {
  secret?: string;
  nowMs?: number;
};

// The signing secret is the Better Auth secret by default: rotating it
// invalidates outstanding links, which is the behaviour we want. Failing
// loud here mirrors getDb() - a misconfigured deploy should not silently
// mint unverifiable links.
function resolveSecret(explicit?: string): string {
  const secret = explicit ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set; cannot sign invoice PDF links.",
    );
  }
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function signInvoicePdfToken(
  input: { invoiceId: string; businessId: string; markSent?: boolean },
  opts: SignOptions = {},
): string {
  const secret = resolveSecret(opts.secret);
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload: InvoicePdfTokenPayload = {
    invoiceId: input.invoiceId,
    businessId: input.businessId,
    exp: Math.floor(nowMs / 1000) + ttl,
    markSent: input.markSent === true,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifyInvoicePdfToken(
  token: string,
  opts: VerifyOptions = {},
): InvoicePdfTokenPayload | null {
  const secret = resolveSecret(opts.secret);
  const nowMs = opts.nowMs ?? Date.now();

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  // Constant-time compare; bail before comparing if the lengths differ, since
  // timingSafeEqual throws on unequal-length buffers.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: InvoicePdfTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload?.invoiceId !== "string" ||
    typeof payload?.businessId !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return null;
  }
  if (Math.floor(nowMs / 1000) >= payload.exp) return null;
  return { ...payload, markSent: payload.markSent === true };
}
