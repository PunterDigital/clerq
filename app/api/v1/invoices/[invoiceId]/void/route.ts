import { invoiceIn } from "@/server/api/invoices";
import { voidInvoiceBodySchema } from "@/server/api/schemas";
import { apiRoute, idParam, readOptionalBody } from "@/server/api/v1";

// POST /api/v1/invoices/:invoiceId/void - void a sent or overdue invoice,
// optionally { "reason": "..." }. It keeps its number and its time goes back
// to unbilled. 409 for a draft (delete it), a paid or a void invoice.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  const { reason } = voidInvoiceBodySchema.parse(await readOptionalBody(req));
  await invoiceIn(
    ctx,
    invoiceId,
    ["sent", "overdue"],
    "Only sent or overdue invoices can be voided",
  );
  return ctx.caller.invoices.void({ invoiceId, reason });
});
