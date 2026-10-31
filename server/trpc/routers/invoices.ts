import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "@/db";
import { fetchEcbRate } from "@/modules/billing/fx";
import {
  addManualLine,
  deleteInvoiceLine,
  generateLinesFromUnbilledTime,
  setInvoiceNotes,
  updateInvoiceLine,
} from "@/modules/billing/generate";
import {
  configureNextInvoiceNumber,
  createDraftInvoice,
  deleteDraftInvoice,
  duplicateInvoice,
  issueInvoice,
  updateInvoiceDetails,
} from "@/modules/billing/invoices";
import {
  getInvoice,
  listInvoices,
  markInvoicePaid,
  voidInvoice,
} from "@/modules/billing/lifecycle";

import { createTRPCRouter, permissionProcedure } from "../init";

function found<T>(row: T | null): T {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
  }
  return row;
}

const treatmentSchema = z.enum(["standard", "zero_rated", "reverse_charge"]);

// A billing period is a range: both ends together and in order, so a
// half-set period can never reach the PDF.
function periodInOrder(v: {
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): boolean {
  return (
    (v.periodStart == null) === (v.periodEnd == null) &&
    (v.periodStart == null || v.periodEnd == null || v.periodStart <= v.periodEnd)
  );
}

const periodRule = {
  message: "Give both billing-period dates, with the start on or before the end",
  path: ["periodEnd"],
};

// Exported for the REST API, which parses request bodies with the same
// schemas so a 422 names the field.
export const draftInvoiceInputSchema = z
  .object({
    clientId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    taxTreatment: treatmentSchema,
    issueDate: z.date().nullable().optional(),
    dueDate: z.date().nullable().optional(),
    periodStart: z.date().nullable().optional(),
    periodEnd: z.date().nullable().optional(),
  })
  .refine(periodInOrder, periodRule);

const detailsFields = {
  issueDate: z.date().nullable(),
  dueDate: z.date().nullable(),
  periodStart: z.date().nullable(),
  periodEnd: z.date().nullable(),
};

export const invoiceDetailsSchema = z
  .object(detailsFields)
  .refine(periodInOrder, periodRule);

export const generateFromTimeSchema = z.object({
  invoiceId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  grouping: z.enum(["person_rate", "task", "single"]),
  includeTaskList: z.boolean().default(false),
  // Clear the draft's previously generated lines (releasing their time
  // back to the pool) and regenerate - the fix for a wrong grouping
  // choice. Manual fixed-amount lines are untouched.
  replace: z.boolean().default(false),
  fxRates: z
    .record(
      z.string().regex(/^[A-Z]{3}$/),
      z.object({
        rate: z.string().regex(/^\d+(\.\d+)?$/),
        source: z.enum(["ecb", "manual"]),
      }),
    )
    .optional(),
});

export const lineInputSchema = z.object({
  description: z.string().trim().min(1),
  amountMajor: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "Enter a plain amount like 1500 or 1500.00"),
});

export const invoicesRouter = createTRPCRouter({
  list: permissionProcedure("invoices.view")
    .input(z.object({ search: z.string().optional() }).optional())
    .query(({ ctx, input }) =>
      listInvoices(getDb(), ctx.businessId, undefined, {
        search: input?.search,
      }),
    ),

  get: permissionProcedure("invoices.view")
    .input(z.object({ invoiceId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      found(await getInvoice(getDb(), ctx.businessId, input.invoiceId)),
    ),

  createDraft: permissionProcedure("invoices.create")
    .input(draftInvoiceInputSchema)
    .mutation(async ({ ctx, input }) => {
      // The standard rate comes from tax_config only - the engine fails
      // loud when the treatment needs one and none is configured.
      const [businessRow] = await getDb()
        .select({ taxConfig: schema.business.taxConfig })
        .from(schema.business)
        .where(eq(schema.business.id, ctx.businessId));
      const taxConfig = (businessRow?.taxConfig ?? {}) as {
        standardRatePct?: string;
      };
      if (input.taxTreatment === "standard" && !taxConfig.standardRatePct) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Set your standard VAT rate in settings before creating a standard-rate invoice",
        });
      }
      return found(
        await createDraftInvoice(getDb(), ctx.businessId, {
          clientId: input.clientId,
          projectId: input.projectId ?? null,
          currency: input.currency,
          taxTreatment: input.taxTreatment,
          standardRatePercent: taxConfig.standardRatePct,
          issueDate: input.issueDate ?? null,
          dueDate: input.dueDate ?? null,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
        }),
      );
    }),

  generateFromTime: permissionProcedure("invoices.edit")
    .input(generateFromTimeSchema)
    .mutation(({ ctx, input }) =>
      generateLinesFromUnbilledTime(getDb(), ctx.businessId, input),
    ),

  // Server-side ECB lookup (keyless, no CORS) for the generate flow. The
  // chosen rate is only ever applied via generateFromTime's fxRates input,
  // so what the user confirmed is exactly what is stored.
  fetchRate: permissionProcedure("invoices.view")
    .input(
      z.object({
        from: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
        to: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
      }),
    )
    .query(({ input }) =>
      fetchEcbRate({ date: new Date(), from: input.from, to: input.to }),
    ),

  deleteLine: permissionProcedure("invoices.edit")
    .input(z.object({ lineId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      found(await deleteInvoiceLine(getDb(), ctx.businessId, input.lineId)),
    ),

  // Fixed-amount manual line - invoices are dual-purpose, not only
  // generated from time.
  addLine: permissionProcedure("invoices.edit")
    .input(lineInputSchema.extend({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await addManualLine(getDb(), ctx.businessId, input);
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === "bad_amount" ? "BAD_REQUEST" : "NOT_FOUND",
          message:
            result.reason === "bad_amount"
              ? "That amount has more decimal places than the invoice currency allows"
              : "Only draft invoices can be edited",
        });
      }
      return result.invoice;
    }),

  // Edit an existing draft line's description and amount in place. Draft-only;
  // changing the amount drops any derived hours x rate breakdown on the line
  // (see updateInvoiceLine).
  updateLine: permissionProcedure("invoices.edit")
    .input(lineInputSchema.extend({ lineId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await updateInvoiceLine(getDb(), ctx.businessId, input);
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === "bad_amount" ? "BAD_REQUEST" : "NOT_FOUND",
          message:
            result.reason === "bad_amount"
              ? "That amount has more decimal places than the invoice currency allows"
              : "Only draft invoices can be edited",
        });
      }
      return result.invoice;
    }),

  // Editable dated metadata on a draft: issue date (used and dated at issue
  // time), due date, billing period. Draft-only, so a null result means
  // there is no draft to edit.
  updateDetails: permissionProcedure("invoices.edit")
    .input(
      z
        .object({ invoiceId: z.string().uuid(), ...detailsFields })
        .refine(periodInOrder, periodRule),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await updateInvoiceDetails(
        getDb(),
        ctx.businessId,
        input.invoiceId,
        {
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      );
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Only draft invoices can be edited",
        });
      }
      return updated;
    }),

  // Free-text notes shown at the foot of the invoice. Draft-only, so a
  // null result means there is no draft to edit.
  setNotes: permissionProcedure("invoices.edit")
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        notes: z.string().max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await setInvoiceNotes(
        getDb(),
        ctx.businessId,
        input.invoiceId,
        input.notes,
      );
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Only draft invoices can be edited",
        });
      }
      return updated;
    }),

  issue: permissionProcedure("invoices.issue")
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await issueInvoice(getDb(), ctx.businessId, input.invoiceId);
      if (!result.ok) {
        if (result.reason === "missing_vat_numbers") {
          const parts = (result.missing ?? []).map((m) =>
            m === "business" ? "yours (in settings)" : "the client's (on their page)",
          );
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Reverse-charge invoices need both VAT numbers printed - add ${parts.join(" and ")}`,
          });
        }
        throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
      }
      return result.invoice;
    }),

  markPaid: permissionProcedure("invoices.markPaid")
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      found(await markInvoicePaid(getDb(), ctx.businessId, input.invoiceId)),
    ),

  // Voids a sent/overdue invoice (e.g. to re-issue a corrected copy). The
  // number is kept; only sent/overdue can be voided, so found() turns a
  // missing or wrong-status invoice into a clean NOT_FOUND.
  void: permissionProcedure("invoices.void")
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      found(
        await voidInvoice(
          getDb(),
          ctx.businessId,
          ctx.session.user.id,
          input.invoiceId,
          input.reason,
        ),
      ),
    ),

  // Copies any invoice into a fresh editable draft (no number/status carried
  // over, lines detached from the source's time entries).
  duplicate: permissionProcedure("invoices.create")
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      found(await duplicateInvoice(getDb(), ctx.businessId, input.invoiceId)),
    ),

  // Deletes a draft (issued invoices are kept - void them instead). Releases
  // any linked time entries back to unbilled via the line cascade.
  delete: permissionProcedure("invoices.delete")
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteDraftInvoice(
        getDb(),
        ctx.businessId,
        input.invoiceId,
      );
      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Only draft invoices can be deleted",
        });
      }
      return { ok: true as const };
    }),

  configureNextNumber: permissionProcedure("invoices.configure")
    .input(
      z.object({
        year: z.number().int().min(2000).max(2200),
        nextNumber: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await configureNextInvoiceNumber(
        getDb(),
        ctx.businessId,
        input.year,
        input.nextNumber,
      );
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
      }
      return result;
    }),
});
