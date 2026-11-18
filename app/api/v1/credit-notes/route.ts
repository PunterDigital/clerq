import { apiRoute, idParam, paginate } from "@/server/api/v1";

// GET /api/v1/credit-notes - credit notes (#5042), newest first, with the
// client name and the credited invoice's number. ?invoiceId=, ?clientId=.
// Paged. Issue one with POST /invoices/:invoiceId/credit-notes.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const invoiceParam = url.searchParams.get("invoiceId");
  const invoiceId = invoiceParam === null ? null : idParam(invoiceParam, "invoice");
  const clientParam = url.searchParams.get("clientId");
  const clientId = clientParam === null ? null : idParam(clientParam, "client");
  const notes = await caller.invoices.creditNotes();
  return paginate(
    notes.filter(
      (note) =>
        (invoiceId === null || note.invoiceId === invoiceId) &&
        (clientId === null || note.clientId === clientId),
    ),
    url,
  );
});
