import { issueCreditNoteBodySchema } from "@/server/api/schemas";
import { apiRoute, created, idParam, readOptionalBody } from "@/server/api/v1";

// POST /api/v1/invoices/:invoiceId/credit-notes - issue a credit note
// (#5042) against a sent, overdue or paid invoice. No body (or no "lines")
// credits everything left; { "lines": [{ "invoiceLineId", "amountMajor" }],
// "reason"? } credits part of it. 409 when the invoice can't be credited
// (a draft, void, or nothing left), 422 for an amount over what's left.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (req, { caller, params }) => {
  const invoiceId = idParam(params.invoiceId, "invoice");
  const body = issueCreditNoteBodySchema.parse(await readOptionalBody(req));
  return created(await caller.invoices.issueCreditNote({ invoiceId, ...body }));
});
