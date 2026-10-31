import {
  expenseInputSchema,
  expenseStatusSchema,
} from "@/modules/expenses/service";
import { publicExpense, refuseReceipt } from "@/server/api/expenses";
import {
  ApiError,
  apiRoute,
  created,
  dateField,
  dateParam,
  paginate,
  readBody,
} from "@/server/api/v1";

// GET /api/v1/expenses - newest first. ?status= (unpaid, paid), ?from=&to=
// (ISO dates, incurredAt in [from, to)), ?search= (description, vendor or
// category contains). Paged.
// POST /api/v1/expenses - create one: { "description", "amountMinor",
// "currency", "incurredAt", "vendor"?, "category"?, "notes"? }. Receipts are
// added in the app.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === null ? null : expenseStatusSchema.safeParse(statusParam);
  if (status && !status.success) {
    throw new ApiError(
      422,
      `status must be one of: ${expenseStatusSchema.options.join(", ")}`,
    );
  }
  const from = dateParam(url, "from");
  const to = dateParam(url, "to");
  if (from && to && from >= to) {
    throw new ApiError(422, "from must be before to");
  }

  const expenses = await caller.expenses.list({
    status: status?.data,
    search: url.searchParams.get("search") ?? undefined,
  });
  return paginate(
    expenses.filter(
      (expense) =>
        (from === null || expense.incurredAt >= from) &&
        (to === null || expense.incurredAt < to),
    ),
    url,
  );
});

export const POST = apiRoute(async (req, { caller }) => {
  const body = await readBody(req);
  refuseReceipt(body);
  dateField(body, "incurredAt");
  const expense = await caller.expenses.create(expenseInputSchema.parse(body));
  return created(publicExpense(expense));
});
