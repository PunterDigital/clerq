import { z } from "zod";

import { expenseStatusSchema } from "@/modules/expenses/service";
import { taskStatusSchema } from "@/modules/projects/tasks-service";

import { SCHEDULE_STATUSES } from "./recurring";

// Request bodies that belong to one endpoint rather than to a module. They
// live here, not in the route files, so the OpenAPI document
// (server/api/openapi.ts) describes the exact schema each endpoint parses with.
// Next only allows its own exports in a route.ts.

// POST /clients/:clientId/notes
export const clientNoteBodySchema = z.object({ text: z.string() });

// POST /expenses/:expenseId/status
export const expenseStatusBodySchema = z.object({ status: expenseStatusSchema });

// PATCH /invoices/:invoiceId (the notes half; the dates use invoiceDetailsSchema)
export const invoiceNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
});

// POST /invoices/:invoiceId/void
export const voidInvoiceBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// POST /recurring-invoices/:scheduleId/status
export const scheduleStatusBodySchema = z.object({
  status: z.enum(SCHEDULE_STATUSES),
});

// POST /tasks/:taskId/status
export const taskStatusBodySchema = z.object({ status: taskStatusSchema });

// PATCH /time-entries/:entryId
export const timeEntryNoteBodySchema = z.object({ note: z.string().nullable() });

// POST /timer/start
export const timerStartBodySchema = z.object({ taskId: z.string().uuid() });
