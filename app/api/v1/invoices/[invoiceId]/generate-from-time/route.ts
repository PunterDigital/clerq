import { DRAFT_ONLY, invoiceIn } from "@/server/api/invoices";
import { apiRoute, idParam, readBody } from "@/server/api/v1";
import { generateFromTimeSchema } from "@/server/trpc/routers/invoices";

// POST /api/v1/invoices/:invoiceId/generate-from-time - fill a draft with
// lines from the client's unbilled billable time: { "grouping": "person_rate"
// | "task" | "single", "projectId"?, "includeTaskList"?, "replace"?,
// "fxRates"? }. The result says what was added, or why nothing was
// (nothing_to_bill, missing_fx_rates). 409 once the invoice is issued.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  const input = generateFromTimeSchema.parse({ ...(await readBody(req)), invoiceId });
  await invoiceIn(ctx, invoiceId, ["draft"], DRAFT_ONLY);
  return ctx.caller.invoices.generateFromTime(input);
});
