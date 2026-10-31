import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "@/db";
import { majorToMinor } from "@/modules/billing/currency";
import {
  createSchedule,
  deleteSchedule,
  generateNow,
  getSchedule,
  listGeneratedInvoices,
  listSchedules,
  setScheduleStatus,
  updateSchedule,
  type ScheduleInput,
} from "@/modules/billing/recurring";

import { createTRPCRouter, permissionProcedure } from "../init";

function found<T>(row: T | null): T {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such recurring invoice" });
  }
  return row;
}

const lineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  amountMajor: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "Enter a plain amount like 1500 or 1500.00"),
});

// Exported for the REST API, which parses bodies with it so a 422 names the
// field.
export const recurringBodySchema = z
  .object({
    clientId: z.string().uuid(),
    projectId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    taxTreatment: z.enum(["standard", "zero_rated", "reverse_charge"]),
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    interval: z.number().int().min(1).max(52),
    startDate: z.date(),
    endDate: z.date().nullable().optional(),
    occurrenceLimit: z.number().int().min(1).max(1000).nullable().optional(),
    netTermsDays: z.number().int().min(0).max(365),
    autoIssue: z.boolean(),
    notes: z.string().max(2000).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(50),
  })
  // A stop date can't fall before the schedule even begins.
  .refine((v) => v.endDate == null || v.endDate >= v.startDate, {
    message: "The end date must be on or after the start date",
    path: ["endDate"],
  });

type Body = z.infer<typeof recurringBodySchema>;

// Turns the wire body into a service ScheduleInput: converts each line's
// major-unit amount into exact minor units in the schedule currency (rejected,
// never rounded, when it has more decimals than the currency allows), and
// enforces the same standard-rate precondition the draft-invoice flow does.
async function toScheduleInput(
  businessId: string,
  body: Body,
): Promise<ScheduleInput> {
  if (body.taxTreatment === "standard") {
    const [businessRow] = await getDb()
      .select({ taxConfig: schema.business.taxConfig })
      .from(schema.business)
      .where(eq(schema.business.id, businessId));
    const taxConfig = (businessRow?.taxConfig ?? {}) as { standardRatePct?: string };
    if (!taxConfig.standardRatePct) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Set your standard VAT rate in settings before creating a standard-rate retainer",
      });
    }
  }

  const lines = body.lines.map((line) => {
    const amountMinor = majorToMinor(line.amountMajor, body.currency);
    if (amountMinor === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `"${line.description}" has more decimal places than ${body.currency} allows`,
      });
    }
    return { description: line.description, amountMinor };
  });

  return {
    clientId: body.clientId,
    projectId: body.projectId ?? null,
    name: body.name,
    currency: body.currency,
    taxTreatment: body.taxTreatment,
    frequency: body.frequency,
    interval: body.interval,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    occurrenceLimit: body.occurrenceLimit ?? null,
    netTermsDays: body.netTermsDays,
    autoIssue: body.autoIssue,
    notes: body.notes ?? null,
    lines,
  };
}

export const recurringRouter = createTRPCRouter({
  list: permissionProcedure("invoices.view").query(({ ctx }) =>
    listSchedules(getDb(), ctx.businessId),
  ),

  get: permissionProcedure("invoices.view")
    .input(z.object({ scheduleId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      found(await getSchedule(getDb(), ctx.businessId, input.scheduleId)),
    ),

  // The invoices a schedule has produced, for its detail page.
  generated: permissionProcedure("invoices.view")
    .input(z.object({ scheduleId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      listGeneratedInvoices(getDb(), ctx.businessId, input.scheduleId),
    ),

  create: permissionProcedure("invoices.manageRecurring")
    .input(recurringBodySchema)
    .mutation(async ({ ctx, input }) =>
      found(
        await createSchedule(
          getDb(),
          ctx.businessId,
          await toScheduleInput(ctx.businessId, input),
        ),
      ),
    ),

  update: permissionProcedure("invoices.manageRecurring")
    .input(z.object({ scheduleId: z.string().uuid(), data: recurringBodySchema }))
    .mutation(async ({ ctx, input }) =>
      found(
        await updateSchedule(
          getDb(),
          ctx.businessId,
          input.scheduleId,
          await toScheduleInput(ctx.businessId, input.data),
        ),
      ),
    ),

  setStatus: permissionProcedure("invoices.manageRecurring")
    .input(
      z.object({
        scheduleId: z.string().uuid(),
        status: z.enum(["active", "paused", "ended"]),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      found(
        await setScheduleStatus(
          getDb(),
          ctx.businessId,
          input.scheduleId,
          input.status,
        ),
      ),
    ),

  // Generates the next scheduled invoice immediately, without waiting for the
  // sweep. Returns how many were created and whether auto-issue hit a snag.
  generateNow: permissionProcedure("invoices.manageRecurring")
    .input(z.object({ scheduleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      found(await generateNow(getDb(), ctx.businessId, input.scheduleId)),
    ),

  delete: permissionProcedure("invoices.manageRecurring")
    .input(z.object({ scheduleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteSchedule(
        getDb(),
        ctx.businessId,
        input.scheduleId,
      );
      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No such recurring invoice",
        });
      }
      return { ok: true as const };
    }),
});
