import { z } from "zod";

import { expenseStatusSchema } from "@/modules/expenses/service";
import { publicExpense } from "@/server/api/expenses";
import { apiRoute, idParam, readBody } from "@/server/api/v1";

// POST /api/v1/expenses/:expenseId/status - { "status": "paid" | "unpaid" }.
export const dynamic = "force-dynamic";

const statusSchema = z.object({ status: expenseStatusSchema });

export const POST = apiRoute<{ expenseId: string }>(async (req, { caller, params }) => {
  const expenseId = idParam(params.expenseId, "expense");
  const { status } = statusSchema.parse(await readBody(req));
  return publicExpense(await caller.expenses.setStatus({ expenseId, status }));
});
