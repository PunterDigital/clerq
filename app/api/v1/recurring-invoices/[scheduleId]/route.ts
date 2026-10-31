import { minorToMajor } from "@/modules/billing/currency";
import { recurringDateFields } from "@/server/api/recurring";
import { apiRoute, idParam, mergeInput, readBody } from "@/server/api/v1";
import { recurringBodySchema } from "@/server/trpc/routers/recurring";

// GET /api/v1/recurring-invoices/:scheduleId - one schedule with its lines.
// PATCH /api/v1/recurring-invoices/:scheduleId - change the fields sent; the
// rest keep their values ("lines" is replaced as a whole list). Invoices it
// already generated don't change.
// DELETE /api/v1/recurring-invoices/:scheduleId - delete the schedule. The
// invoices it generated stay.
export const dynamic = "force-dynamic";

type Params = { scheduleId: string };

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.recurring.get({ scheduleId: idParam(params.scheduleId, "recurring invoice") }),
);

export const PATCH = apiRoute<Params>(async (req, { caller, params }) => {
  const scheduleId = idParam(params.scheduleId, "recurring invoice");
  const patch = await readBody(req);
  recurringDateFields(patch);
  const current = await caller.recurring.get({ scheduleId });
  // The body takes line amounts in major units; the schedule stores minor.
  const currentBody = {
    ...current,
    lines: current.lines.map((line) => ({
      description: line.description,
      amountMajor: minorToMajor(line.amountMinor, current.currency),
    })),
  };
  const data = recurringBodySchema.parse(
    mergeInput(recurringBodySchema, currentBody, patch),
  );
  return caller.recurring.update({ scheduleId, data });
});

export const DELETE = apiRoute<Params>(async (_req, { caller, params }) =>
  caller.recurring.delete({ scheduleId: idParam(params.scheduleId, "recurring invoice") }),
);
