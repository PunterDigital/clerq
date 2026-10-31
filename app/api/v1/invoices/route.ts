import { INVOICE_STATUSES, invoiceDateFields } from "@/server/api/invoices";
import {
  ApiError,
  apiRoute,
  created,
  idParam,
  paginate,
  readBody,
} from "@/server/api/v1";
import { draftInvoiceInputSchema } from "@/server/trpc/routers/invoices";

// GET /api/v1/invoices - newest first, with client names. ?status=,
// ?clientId=, ?search= (number or client name contains). Paged.
// POST /api/v1/invoices - create a draft: { "clientId", "currency",
// "taxTreatment", "projectId"?, "issueDate"?, "dueDate"?, "periodStart"?,
// "periodEnd"? }.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, url }) => {
  const status = url.searchParams.get("status");
  if (
    status !== null &&
    !(INVOICE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ApiError(422, `status must be one of: ${INVOICE_STATUSES.join(", ")}`);
  }
  const clientParam = url.searchParams.get("clientId");
  const clientId = clientParam === null ? null : idParam(clientParam, "client");

  const invoices = await caller.invoices.list({
    search: url.searchParams.get("search") ?? undefined,
  });
  return paginate(
    invoices.filter(
      (invoice) =>
        (status === null || invoice.status === status) &&
        (clientId === null || invoice.clientId === clientId),
    ),
    url,
  );
});

export const POST = apiRoute(async (req, { caller }) => {
  const body = await readBody(req);
  invoiceDateFields(body);
  return created(await caller.invoices.createDraft(draftInvoiceInputSchema.parse(body)));
});
