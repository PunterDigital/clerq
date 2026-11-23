import { getDb } from "@/db";
import { exportCreditNoteEinvoice } from "@/modules/einvoice/service";
import { resolveDownloadAccess } from "@/server/download-access";

// GET /api/credit-notes/:creditNoteId/einvoice - the "Download e-invoice
// (XML)" button on a credit note (#5042): a Peppol BIS 3.0 UBL CreditNote
// for the signed-in user's business. 422 lists what's missing.
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
  if (!/^[0-9a-f-]{36}$/i.test(creditNoteId)) {
    return new Response("Not found", { status: 404 });
  }
  const result = await exportCreditNoteEinvoice(
    getDb(),
    access.businessId,
    creditNoteId,
  );
  if (!result) {
    return new Response("Not found", { status: 404 });
  }
  if (!result.ok) {
    return new Response(
      `This credit note can't be exported yet:\n- ${result.missing.join("\n- ")}\n`,
      { status: 422, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(result.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
