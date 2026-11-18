import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { getCreditNote } from "@/modules/billing/credit-notes";
import { buildCreditNotePdfData } from "@/modules/billing/pdf-data";
import { getActiveMembership } from "@/server/membership";
import { getEffectiveSession } from "@/server/session";
import { buildInvoicePdf } from "@/server/pdf/invoice-document";

// GET /api/credit-notes/:creditNoteId/pdf - the "Download PDF" button on a
// credit note (#5042), for the signed-in user's business. PDF/A-3b like
// the invoice PDFs; the e-invoice (UBL CreditNote / Factur-X 381) comes
// with the e-invoice export of credit notes.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ creditNoteId: string }> },
) {
  const { creditNoteId } = await params;
  const session = await getEffectiveSession(req.headers);
  if (!session) {
    return new Response("Sign in first", { status: 401 });
  }
  const membership = await getActiveMembership(session.user.id);
  if (!membership) {
    return new Response("No business", { status: 403 });
  }
  const businessId = membership.businessId;
  const db = getDb();
  // Not a uuid: no such credit note (Postgres would refuse the cast).
  if (!/^[0-9a-f-]{36}$/i.test(creditNoteId)) {
    return new Response("Not found", { status: 404 });
  }
  const creditNote = await getCreditNote(db, businessId, creditNoteId);
  if (!creditNote) {
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
    .where(
      and(
        eq(schema.client.businessId, businessId),
        eq(schema.client.id, creditNote.clientId),
      ),
    );

  const data = buildCreditNotePdfData({
    creditNote,
    invoiceNumber: creditNote.invoiceNumber,
    invoiceIssueDate: creditNote.invoiceIssueDate,
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
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="credit-note-${creditNote.number}.pdf"`,
    },
  });
}
