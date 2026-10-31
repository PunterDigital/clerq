import { apiRoute, idParam } from "@/server/api/v1";
import { signInvoicePdfToken } from "@/server/mcp/pdf-link";

// GET /api/v1/invoices/:invoiceId/pdf-link - a signed URL that downloads the
// invoice PDF without a key or login, valid for 15 minutes.
export const dynamic = "force-dynamic";

const TTL_SECONDS = 15 * 60;

export const GET = apiRoute<{ invoiceId: string }>(async (_req, { caller, key, params, url }) => {
  const invoiceId = idParam(params.invoiceId, "invoice");
  // Confirms the invoice is in the key's business before minting a link.
  const invoice = await caller.invoices.get({ invoiceId });
  const token = signInvoicePdfToken(
    { invoiceId, businessId: key.businessId },
    { ttlSeconds: TTL_SECONDS },
  );
  const link = new URL(`/api/invoices/${invoiceId}/pdf`, url.origin);
  link.searchParams.set("token", token);
  return {
    url: link.toString(),
    invoiceNumber: invoice.number,
    expiresInSeconds: TTL_SECONDS,
  };
});
