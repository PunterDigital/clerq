import { ApiError, apiRoute, idParam } from "@/server/api/v1";

// POST /api/v1/recurring-invoices/:scheduleId/generate - generate the next
// invoice now instead of waiting for its date: { "generated", "issued",
// "error" }. 409 unless the schedule is active.
export const dynamic = "force-dynamic";

export const POST = apiRoute<{ scheduleId: string }>(async (_req, { caller, params }) => {
  const scheduleId = idParam(params.scheduleId, "recurring invoice");
  const schedule = await caller.recurring.get({ scheduleId });
  if (schedule.status !== "active") {
    throw new ApiError(409, "Only an active recurring invoice can generate an invoice");
  }
  return caller.recurring.generateNow({ scheduleId });
});
