import { invoiceIn } from "@/server/api/invoices";
import { apiRoute, idParam } from "@/server/api/v1";

// POST /api/v1/invoices/:invoiceId/issue - number the draft and mark it sent.
// 409 if it is already issued, or a reverse-charge invoice lacks a VAT number.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (_req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  await invoiceIn(ctx, invoiceId, ["draft"], "This invoice is already issued");
  return ctx.caller.invoices.issue({ invoiceId });
});
