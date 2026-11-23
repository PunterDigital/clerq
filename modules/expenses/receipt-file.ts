import { createHash } from "node:crypto";

// Turns a stored receipt (a base64 data URL, see receiptSchema in
// service.ts) into an HTTP response (#5693). Only the three types the
// schema accepts are served as themselves; anything else in an old row goes
// out as an opaque attachment, so nothing stored can render as HTML or SVG
// on the app's origin.
const SERVED_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);

export type StoredReceipt = {
  id: string;
  dataUrl: string;
  filename: string | null;
};

export function decodeReceipt(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };
}

// A quoted ETag from the stored bytes: changes exactly when the receipt does.
export function receiptEtag(receipt: StoredReceipt): string {
  const digest = createHash("sha256").update(receipt.dataUrl).digest("base64url");
  return `"${digest.slice(0, 27)}"`;
}

// RFC 6266 filename: an ASCII fallback plus the UTF-8 original.
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function receiptResponse(
  receipt: StoredReceipt,
  opts: { download?: boolean; ifNoneMatch?: string | null } = {},
): Response {
  const decoded = decodeReceipt(receipt.dataUrl);
  if (!decoded) {
    return new Response("Not found", { status: 404 });
  }
  const etag = receiptEtag(receipt);
  // Private: it's one business's document, never for a shared cache.
  // no-cache: the browser keeps it but asks again each time, so a replaced
  // receipt or a lost permission shows on the next view (a 304 is cheap).
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  const matches = opts.ifNoneMatch
    ?.split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
  if (matches) {
    return new Response(null, { status: 304, headers });
  }
  const servable = SERVED_TYPES.has(decoded.mimeType);
  const filename = receipt.filename ?? "receipt";
  return new Response(new Uint8Array(decoded.bytes), {
    headers: {
      ...headers,
      "Content-Type": servable ? decoded.mimeType : "application/octet-stream",
      "Content-Length": String(decoded.bytes.length),
      "Content-Disposition": contentDisposition(
        opts.download || !servable ? "attachment" : "inline",
        filename,
      ),
    },
  });
}
