import { apiRoute, idParam } from "@/server/api/v1";

// GET /api/v1/credit-notes/:creditNoteId - one credit note (#5042) with its
// lines and the credited invoice's number and issue date.
export const dynamic = "force-dynamic";

export const GET = apiRoute<{ creditNoteId: string }>(async (_req, { caller, params }) =>
  caller.invoices.creditNote({
    creditNoteId: idParam(params.creditNoteId, "credit note"),
  }),
);
