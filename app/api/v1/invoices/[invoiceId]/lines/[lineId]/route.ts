import { minorToMajor } from "@/modules/billing/currency";
import { DRAFT_ONLY, invoiceIn } from "@/server/api/invoices";
import {
  ApiError,
  apiRoute,
  idParam,
  mergeInput,
  readBody,
  type ApiContext,
} from "@/server/api/v1";
import { lineInputSchema } from "@/server/trpc/routers/invoices";

// PATCH /api/v1/invoices/:invoiceId/lines/:lineId - change a draft line's
// "description" and/or "amountMajor". A new amount replaces the line's
// hours x rate breakdown. Answers with the invoice.
// DELETE /api/v1/invoices/:invoiceId/lines/:lineId - remove a draft line; its
// time goes back to unbilled.
// Both are 409 once the invoice is issued.
export const dynamic = "force-dynamic";

type Params = { invoiceId: string; lineId: string };

async function draftLine(ctx: ApiContext<Params>) {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  const lineId = idParam(ctx.params.lineId, "invoice line");
  const invoice = await invoiceIn(ctx, invoiceId, ["draft"], DRAFT_ONLY);
  const line = invoice.lines.find((l) => l.id === lineId);
  if (!line) throw new ApiError(404, "No such invoice line");
  return { invoice, line };
}

export const PATCH = apiRoute<Params>(async (req, ctx) => {
  const patch = await readBody(req);
  const { invoice, line } = await draftLine(ctx);
  const current = {
    description: line.description,
    amountMajor: minorToMajor(line.totalMinor, invoice.currency),
  };
  const data = lineInputSchema.parse(mergeInput(lineInputSchema, current, patch));
  return ctx.caller.invoices.updateLine({ lineId: line.id, ...data });
});

export const DELETE = apiRoute<Params>(async (_req, ctx) => {
  const { line } = await draftLine(ctx);
  return ctx.caller.invoices.deleteLine({ lineId: line.id });
});
