import { ApiError, apiRoute, idParam } from "@/server/api/v1";

// GET /api/v1/invoices/:invoiceId/einvoice - the issued invoice as a Peppol
// BIS Billing 3.0 UBL 2.1 e-invoice (application/xml). 422 lists what to
// fill in first when it can't be built (a draft, a missing address, ...).
export const dynamic = "force-dynamic";

export const GET = apiRoute<{ invoiceId: string }>(async (_req, { caller, params }) => {
  const invoiceId = idParam(params.invoiceId, "invoice");
  const result = await caller.invoices.einvoice({ invoiceId });
  if (!result.ok) {
    throw new ApiError(422, `Can't export this invoice yet: ${result.missing.join("; ")}`);
  }
  return new Response(result.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});
