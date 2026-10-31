import { z } from "zod";

import { SCHEDULE_STATUSES } from "@/server/api/recurring";
import { apiRoute, idParam, readBody } from "@/server/api/v1";

// POST /api/v1/recurring-invoices/:scheduleId/status - pause, resume or end:
// { "status": "active" | "paused" | "ended" }.
export const dynamic = "force-dynamic";

const statusSchema = z.object({ status: z.enum(SCHEDULE_STATUSES) });

export const POST = apiRoute<{ scheduleId: string }>(async (req, { caller, params }) => {
  const scheduleId = idParam(params.scheduleId, "recurring invoice");
  const { status } = statusSchema.parse(await readBody(req));
  return caller.recurring.setStatus({ scheduleId, status });
});
