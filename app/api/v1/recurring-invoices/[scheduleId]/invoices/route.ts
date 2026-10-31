import { apiRoute, idParam, paginate } from "@/server/api/v1";

// GET /api/v1/recurring-invoices/:scheduleId/invoices - the invoices the
// schedule has generated. Paged.
export const dynamic = "force-dynamic";

export const GET = apiRoute<{ scheduleId: string }>(async (_req, { caller, params, url }) => {
  const scheduleId = idParam(params.scheduleId, "recurring invoice");
  // get() first, so an unknown schedule is a 404 rather than an empty list.
  await caller.recurring.get({ scheduleId });
  return paginate(await caller.recurring.generated({ scheduleId }), url);
});
