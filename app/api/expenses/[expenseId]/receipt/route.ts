import { getDb } from "@/db";
import { getExpense } from "@/modules/expenses/service";
import { receiptResponse } from "@/modules/expenses/receipt-file";
import { resolveDownloadAccess } from "@/server/download-access";

// One expense's receipt as a file (#5693). The expense page used to inline
// the stored base64 data URL (up to ~2 MB) in its HTML and again in the RSC
// payload; it now points an <img> and the Open/Download links here, so the
// bytes load once, lazily, and revalidate with an ETag instead of being
// resent on every visit and router.refresh().
//
// Same gates as the other browser downloads (session, suspensions,
// membership, expenses.view). The business comes from the caller's active
// membership, so another business's expense id is a plain 404.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const access = await resolveDownloadAccess(req.headers, "expenses.view");
  if (access instanceof Response) {
    return access;
  }
  const { expenseId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(expenseId)) {
    return new Response("Not found", { status: 404 });
  }
  const expense = await getExpense(getDb(), access.businessId, expenseId);
  if (!expense?.receiptDataUrl) {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(req.url);
  return receiptResponse(
    {
      id: expense.id,
      dataUrl: expense.receiptDataUrl,
      filename: expense.receiptFilename,
    },
    {
      download: url.searchParams.get("download") === "1",
      ifNoneMatch: req.headers.get("if-none-match"),
    },
  );
}
