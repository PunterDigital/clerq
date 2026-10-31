import { invoiceIn } from "@/server/api/invoices";
import { apiRoute, idParam } from "@/server/api/v1";

// POST /api/v1/invoices/:invoiceId/mark-paid - a sent or overdue invoice
// becomes paid. 409 for any other status.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ invoiceId: string }>(async (_req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  await invoiceIn(
    ctx,
    invoiceId,
    ["sent", "overdue"],
    "Only sent or overdue invoices can be marked paid",
  );
  return ctx.caller.invoices.markPaid({ invoiceId });
});
