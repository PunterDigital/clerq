import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { getCreditNote } from "@/modules/billing/credit-notes";
import { buildCreditNotePdfData } from "@/modules/billing/pdf-data";
import {
  documentFilename,
  facturXForCreditNote,
} from "@/modules/einvoice/service";
import { resolveDownloadAccess } from "@/server/download-access";
import { buildInvoicePdf } from "@/server/pdf/invoice-document";

// GET /api/credit-notes/:creditNoteId/pdf - the "Download PDF" button on a
// credit note (#5042), for the signed-in user's business. PDF/A-3b like
// the invoice PDFs, with Factur-X (type 381) attached when the credit note
// can be exported as an e-invoice.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ creditNoteId: string }> },
) {
  const { creditNoteId } = await params;
  // The same gates as invoices.creditNote (#5583).
  const access = await resolveDownloadAccess(req.headers, "invoices.view");
  if (access instanceof Response) {
    return access;
  }
  const businessId = access.businessId;
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
  const facturX = await facturXForCreditNote(db, businessId, creditNoteId);
  const pdf = await buildInvoicePdf(data, { facturX });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${documentFilename("credit-note", creditNote.number, "pdf")}"`,
    },
  });
}
