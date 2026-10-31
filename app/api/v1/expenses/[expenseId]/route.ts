import { expenseInputSchema } from "@/modules/expenses/service";
import { publicExpense, refuseReceipt } from "@/server/api/expenses";
import {
  apiRoute,
  dateField,
  idParam,
  mergeInput,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/expenses/:expenseId - one expense (without the receipt file;
// receiptFilename says whether it has one).
// PATCH /api/v1/expenses/:expenseId - change the fields sent; the rest, and
// any receipt, keep their values.
// DELETE /api/v1/expenses/:expenseId - delete it and its receipt.
export const dynamic = "force-dynamic";

type Params = { expenseId: string };

export const GET = apiRoute<Params>(async (_req, { caller, params }) =>
  publicExpense(
    await caller.expenses.get({ expenseId: idParam(params.expenseId, "expense") }),
  ),
);

export const PATCH = apiRoute<Params>(async (req, { caller, params }) => {
  const expenseId = idParam(params.expenseId, "expense");
  const patch = await readBody(req);
  refuseReceipt(patch);
  dateField(patch, "incurredAt");
  const current = await caller.expenses.get({ expenseId });
  // The stored row has no "receipt" field, so the merge leaves it out and
  // the update keeps the receipt.
  const data = expenseInputSchema.parse(
    mergeInput(expenseInputSchema, current, patch),
  );
  return publicExpense(await caller.expenses.update({ expenseId, data }));
});

export const DELETE = apiRoute<Params>(async (_req, { caller, params }) =>
  publicExpense(
    await caller.expenses.delete({ expenseId: idParam(params.expenseId, "expense") }),
  ),
);
