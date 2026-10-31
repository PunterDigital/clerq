import { recurringDateFields, SCHEDULE_STATUSES } from "@/server/api/recurring";
import { ApiError, apiRoute, created, paginate, readBody } from "@/server/api/v1";
import { recurringBodySchema } from "@/server/trpc/routers/recurring";

// GET /api/v1/recurring-invoices - every schedule (retainer) with its client's
// name and next run. ?status= (active, paused, ended). Paged.
// POST /api/v1/recurring-invoices - create a schedule (fields in docs/API.md).
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const status = url.searchParams.get("status");
  if (
    status !== null &&
    !(SCHEDULE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ApiError(422, `status must be one of: ${SCHEDULE_STATUSES.join(", ")}`);
  }
  const schedules = await caller.recurring.list();
  return paginate(
    status === null ? schedules : schedules.filter((s) => s.status === status),
    url,
  );
});

export const POST = apiRoute(async (req, { caller }) => {
  const body = await readBody(req);
  recurringDateFields(body);
  return created(await caller.recurring.create(recurringBodySchema.parse(body)));
});
