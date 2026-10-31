import { apiRoute, created, idParam } from "@/server/api/v1";

// POST /api/v1/invoices/:invoiceId/duplicate - copy any invoice into a new
// draft (no number or status, lines not linked to time).
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (_req, { caller, params }) =>
  created(
    await caller.invoices.duplicate({ invoiceId: idParam(params.invoiceId, "invoice") }),
  ),
);
