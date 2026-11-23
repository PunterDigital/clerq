import { getDb } from "@/db";
import { recordEinvoiceSent } from "@/modules/billing/credit-notes";
import { exportEinvoice } from "@/modules/einvoice/service";
import {
  mayRecordEinvoiceSent,
  resolveDownloadAccess,
} from "@/server/download-access";

// GET /api/invoices/:invoiceId/einvoice - the "Download e-invoice (XML)"
// button: the invoice as Peppol BIS 3.0 UBL, for the signed-in user's
// business. 422 with the list of what's missing when it can't be built.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  // The same gates as invoices.einvoice (#5583).
  const access = await resolveDownloadAccess(req.headers, "invoices.view");
  if (access instanceof Response) {
    return access;
  }
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) {
    return new Response("Not found", { status: 404 });
  }
  const result = await exportEinvoice(getDb(), access.businessId, invoiceId);
  if (!result) {
    return new Response("Not found", { status: 404 });
  }
  if (!result.ok) {
    return new Response(
      `This invoice can't be exported yet:\n- ${result.missing.join("\n- ")}\n`,
      { status: 422, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  // Downloaded = sent as an e-invoice: from now on it is corrected with a
  // credit note, not voided (#5042). Only when the caller could void it
  // (#5583): anyone else who may read the invoice just gets the file.
  if (mayRecordEinvoiceSent({ ...access, readOnlyKey: false })) {
    await recordEinvoiceSent(getDb(), access.businessId, invoiceId);
  }
  return new Response(result.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
