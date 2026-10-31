import { ApiError, dateField, type ApiContext } from "./v1";

type Invoice = Awaited<ReturnType<ApiContext["caller"]["invoices"]["get"]>>;
type InvoiceStatus = Invoice["status"];

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "paid",
  "overdue",
  "void",
] as const satisfies readonly InvoiceStatus[];

export const INVOICE_DATE_FIELDS = [
  "issueDate",
  "dueDate",
  "periodStart",
  "periodEnd",
] as const;

// Turns the invoice date fields of a request body into Dates.
export function invoiceDateFields(body: Record<string, unknown>): void {
  for (const field of INVOICE_DATE_FIELDS) dateField(body, field);
}

// Loads an invoice and refuses with a 409 when its status doesn't allow the
// change. The tRPC procedures guard the status too, but answer NOT_FOUND
// (the row their SQL guard matched was missing), which for a caller holding
// a real invoice id reads as the wrong error.
export async function invoiceIn(
  { caller }: Pick<ApiContext, "caller">,
  invoiceId: string,
  allowed: readonly InvoiceStatus[],
  message: string,
): Promise<Invoice> {
  const invoice = await caller.invoices.get({ invoiceId });
  if (!allowed.includes(invoice.status)) throw new ApiError(409, message);
  return invoice;
}

export const DRAFT_ONLY = "Only draft invoices can be edited";
