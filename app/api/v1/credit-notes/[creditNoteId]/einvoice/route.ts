import { ApiError, apiRoute, idParam } from "@/server/api/v1";

// GET /api/v1/credit-notes/:creditNoteId/einvoice - the credit note (#5042)
// as a Peppol BIS Billing 3.0 UBL CreditNote (application/xml), referencing
// the credited invoice. 422 lists what to fill in first.
export const dynamic = "force-dynamic";

export const GET = apiRoute<{ creditNoteId: string }>(async (_req, { caller, params }) => {
  const creditNoteId = idParam(params.creditNoteId, "credit note");
  const result = await caller.invoices.creditNoteEinvoice({ creditNoteId });
  if (!result.ok) {
    throw new ApiError(422, `Can't export this credit note yet: ${result.missing.join("; ")}`);
  }
  return new Response(result.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});
