import { z } from "zod";

import {
  DRAFT_ONLY,
  INVOICE_DATE_FIELDS,
  invoiceDateFields,
  invoiceIn,
} from "@/server/api/invoices";
import { ApiError, apiRoute, idParam, readBody } from "@/server/api/v1";
import { invoiceDetailsSchema } from "@/server/trpc/routers/invoices";

// GET /api/v1/invoices/:invoiceId - one invoice with its lines.
// PATCH /api/v1/invoices/:invoiceId - a draft's dates ("issueDate",
// "dueDate", "periodStart", "periodEnd") and "notes"; fields left out keep
// their values, null clears one. 409 once the invoice is issued.
// DELETE /api/v1/invoices/:invoiceId - delete a draft and release its time.
// 409 for an issued invoice: void it instead.
export const dynamic = "force-dynamic";

type Params = { invoiceId: string };

const notesSchema = z.object({ notes: z.string().max(2000).nullable() });

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.invoices.get({ invoiceId: idParam(params.invoiceId, "invoice") }),
);

export const PATCH = apiRoute<Params>(async (req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  const patch = await readBody(req);
  const datesSent = INVOICE_DATE_FIELDS.some((field) => field in patch);
  if (!datesSent && !("notes" in patch)) {
    throw new ApiError(
      422,
      `Send at least one of: ${[...INVOICE_DATE_FIELDS, "notes"].join(", ")}`,
    );
  }
  invoiceDateFields(patch);
  const current = await invoiceIn(ctx, invoiceId, ["draft"], DRAFT_ONLY);

  // Validate everything before changing anything, so a bad note can't
  // leave the dates half-applied.
  const details = datesSent
    ? invoiceDetailsSchema.parse(
        Object.fromEntries(
          INVOICE_DATE_FIELDS.map((field) => [
            field,
            field in patch ? patch[field] : current[field],
          ]),
        ),
      )
    : null;
  const notes = "notes" in patch ? notesSchema.parse({ notes: patch.notes }).notes : undefined;

  if (details) await ctx.caller.invoices.updateDetails({ invoiceId, ...details });
  if (notes !== undefined) {
    await ctx.caller.invoices.setNotes({ invoiceId, notes: notes ?? "" });
  }
  return ctx.caller.invoices.get({ invoiceId });
});

export const DELETE = apiRoute<Params>(async (_req, ctx) => {
  const invoiceId = idParam(ctx.params.invoiceId, "invoice");
  await invoiceIn(
    ctx,
    invoiceId,
    ["draft"],
    "Only draft invoices can be deleted; void an issued invoice instead",
  );
  return ctx.caller.invoices.delete({ invoiceId });
});
