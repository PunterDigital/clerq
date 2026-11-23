// Response headers for every route (next.config.ts headers()), from the
// #5473 audit (#5584). Imported by next.config.ts with a relative path, so
// keep this file free of "@/" imports.
//
// The CSP keeps 'unsafe-inline' for scripts and styles: the App Router
// streams its flight data in inline <script> tags and the UI sets inline
// styles, and a nonce would make every page dynamic. What it does buy:
// no framing (clickjacking), no <base> or form hijacking, and every fetch,
// image, font and frame limited to this origin (plus data:/blob: for
// logos, receipts and the PDF previews). Dev mode needs eval and the HMR
// websocket.
const isDev = process.env.NODE_ENV === "development";

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'self' blob:",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS: { key: string; value: string }[] = [
  // Browsers ignore HSTS on plain http, so a self-hosted instance on a LAN
  // without TLS is unaffected.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
