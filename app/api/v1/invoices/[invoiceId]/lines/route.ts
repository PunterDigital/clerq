import { DRAFT_ONLY, invoiceIn } from "@/server/api/invoices";
import { apiRoute, created, idParam, readBody } from "@/server/api/v1";
import { lineInputSchema } from "@/server/trpc/routers/invoices";

// POST /api/v1/invoices/:invoiceId/lines - add a fixed-amount line to a
// draft: { "description", "amountMajor": "1500.00" }. Answers with the
// invoice. 409 once the invoice is issued.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  const line = lineInputSchema.parse(await readBody(req));
  await invoiceIn(ctx, invoiceId, ["draft"], DRAFT_ONLY);
  return created(await ctx.caller.invoices.addLine({ invoiceId, ...line }));
});
