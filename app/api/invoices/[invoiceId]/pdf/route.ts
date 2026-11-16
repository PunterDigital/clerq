import { eq } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { getInvoice } from "@/modules/billing/lifecycle";
import { buildInvoicePdfData } from "@/modules/billing/pdf-data";
import { getEffectiveSession } from "@/server/session";
import { verifyInvoicePdfToken } from "@/server/mcp/pdf-link";
import { getActiveMembership } from "@/server/membership";
import { buildInvoicePdf } from "@/server/pdf/invoice-document";

// Resolve the business this request may read, by either auth path:
//   - a browser session cookie (the download button in the web app), or
//   - a short-lived signed token minted by the MCP `get_invoice_pdf_link`
//     tool, scoped to one invoice in one business.
// Returns the businessId to scope by, or a Response to short-circuit with.
async function resolveBusinessId(
  req: Request,
  invoiceId: string,
): Promise<string | Response> {
  const token = new URL(req.url).searchParams.get("token");
  if (token) {
    const payload = verifyInvoicePdfToken(token);
    // A token is bound to one invoice: reject it on any other URL so a leaked
    // link can never be repointed at a different invoice.
    if (!payload || payload.invoiceId !== invoiceId) {
      return new Response("Invalid or expired link", { status: 401 });
    }
    return payload.businessId;
  }

  const session = await getEffectiveSession(req.headers);
  if (!session) {
    return new Response("Sign in first", { status: 401 });
  }
  const membership = await getActiveMembership(session.user.id);
  if (!membership) {
    return new Response("No business", { status: 403 });
  }
  return membership.businessId;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const resolved = await resolveBusinessId(req, invoiceId);
  if (resolved instanceof Response) {
    return resolved;
  }
  const businessId = resolved;

  const db = getDb();
  const invoice = await getInvoice(db, businessId, invoiceId);
  if (!invoice) {
    return new Response("Not found", { status: 404 });
  }

  const [businessRow] = await db
    .select({
      name: schema.business.name,
      address: schema.business.address,
      taxConfig: schema.business.taxConfig,
      branding: schema.business.branding,
    })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  const branding = (businessRow.branding ?? {}) as {
    logoDataUrl?: string;
    brandColor?: string;
    footerNote?: string;
  };
  const [clientRow] = await db
    .select({
      name: schema.client.name,
      address: schema.client.address,
      companyNumber: schema.client.companyNumber,
      vatNumber: schema.client.vatNumber,
    })
    .from(schema.client)
    .where(eq(schema.client.id, invoice.clientId));

  const data = buildInvoicePdfData({
    invoice,
    business: {
      name: businessRow.name,
      address: businessRow.address,
      vatNumber:
        ((businessRow.taxConfig ?? {}) as { vatNumber?: string }).vatNumber ??
        null,
      brandColor: branding.brandColor ?? null,
      logoDataUrl: branding.logoDataUrl ?? null,
      footerNote: branding.footerNote ?? null,
    },
    client: clientRow,
  });

  const pdf = await buildInvoicePdf(data);
  const filename = invoice.number
    ? `invoice-${invoice.number}.pdf`
    : "draft-invoice.pdf";
  // attachment, not inline: the button says download, and some browser
  // PDF-viewer configurations render an inline response as a blank tab.
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
