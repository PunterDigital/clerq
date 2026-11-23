import { getDb } from "@/db";
import { buildReceiptsArchive } from "@/modules/expenses/receipts-archive";
import { listExpenseReceipts } from "@/modules/expenses/service";
import { resolveDownloadAccess } from "@/server/download-access";

// Download every expense receipt whose incurred date falls in [from, to) as
// a single zip - the "hand a month's invoices to the accountant" action.
// Mirrors the tenancy, suspension and permission gates of the tRPC expense
// procedures, resolved against the browser session because a file download
// has to be a plain GET.
//
// The business is derived from the caller's active membership, never from
// the request, so the archive can only ever contain the caller's own data.
//
// `from`/`to` arrive as full ISO timestamps computed by the client in the
// user's own timezone: receipts' incurred dates are stored as local
// midnights (see expense-form.tsx), so the month boundary has to be drawn
// where the user lives, not where the server runs.

// A year plus slack. The archive is built in memory (receipts are capped at
// ~1.5MB each), so an unbounded range is the one way a caller could balloon
// this into an out-of-memory request.
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const membership = await resolveDownloadAccess(req.headers, "expenses.view");
  if (membership instanceof Response) {
    return membership;
  }

  const url = new URL(req.url);
  const from = new Date(url.searchParams.get("from") ?? "");
  const to = new Date(url.searchParams.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return new Response("Provide from and to as ISO dates", { status: 400 });
  }
  if (from.getTime() >= to.getTime()) {
    return new Response("from must be before to", { status: 400 });
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    return new Response("Range too large - download at most a year at a time", {
      status: 400,
    });
  }

  const rows = await listExpenseReceipts(getDb(), membership.businessId, {
    from,
    to,
  });
  if (rows.length === 0) {
    return new Response("No receipts in this period", { status: 404 });
  }

  const archive = buildReceiptsArchive(rows);

  // The dialog that calls this names the saved file after the chosen month;
  // this header is the fallback for anyone hitting the URL directly.
  const datePart = from.toISOString().slice(0, 10);
  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="expense-receipts-${datePart}.zip"`,
    },
  });
}
