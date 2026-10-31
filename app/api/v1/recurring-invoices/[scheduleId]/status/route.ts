import { scheduleStatusBodySchema } from "@/server/api/schemas";
import { apiRoute, idParam, readBody } from "@/server/api/v1";

// POST /api/v1/recurring-invoices/:scheduleId/status - pause, resume or end:
// { "status": "active" | "paused" | "ended" }.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ scheduleId: string }>(async (req, { caller, params }) => {
  const scheduleId = idParam(params.scheduleId, "recurring invoice");
  const { status } = scheduleStatusBodySchema.parse(await readBody(req));
  return caller.recurring.setStatus({ scheduleId, status });
});
