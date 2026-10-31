import { ApiError } from "./v1";

// The API leaves receipts to the web app's upload and scan flow for now: an
// expense comes back without its receipt bytes (up to ~2 MB as a data URL),
// only whether it has one.
export function publicExpense<T extends { receiptDataUrl?: string | null }>(
  expense: T,
): Omit<T, "receiptDataUrl"> {
  const { receiptDataUrl: _receipt, ...rest } = expense;
  void _receipt;
  return rest;
}

export function refuseReceipt(body: Record<string, unknown>): void {
  if ("receipt" in body) {
    throw new ApiError(
      422,
      "receipt: Receipts can't be uploaded through the API yet; attach them in the app",
    );
  }
}
