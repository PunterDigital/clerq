// Pure helpers for the bulk receipt upload: which picked files are accepted,
// which queued files to scan next, and the end-of-batch tally. Kept free of
// React and the browser so the unit suite can cover them directly.

// The same limits as a single receipt on the expense form (and the server's
// receipt schema), so a file accepted here is never refused on save.
export const MAX_RECEIPT_BYTES = 1_500_000;
export const RECEIPT_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type ReceiptMime = (typeof RECEIPT_TYPES)[number];

// How many files one batch takes, and how many scans run at once. Two at a
// time keeps the batch moving without a burst of calls to the vision model.
export const MAX_BULK_FILES = 20;
export const SCAN_CONCURRENCY = 2;

export type PickedFile = { name: string; size: number; type: string };
export type RejectedFile = { name: string; reason: string };

export function isReceiptMime(type: string): type is ReceiptMime {
  return (RECEIPT_TYPES as readonly string[]).includes(type);
}

// Splits a pick into the files we take and the ones we refuse (with a reason
// to show). `alreadyQueued` counts files from earlier picks in the same
// batch, so the cap applies to the batch, not to each pick.
export function partitionFiles<T extends PickedFile>(
  files: readonly T[],
  alreadyQueued: number,
): { accepted: T[]; rejected: RejectedFile[] } {
  const accepted: T[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    if (!isReceiptMime(file.type)) {
      rejected.push({ name: file.name, reason: "Not a PNG, JPEG or PDF" });
    } else if (file.size > MAX_RECEIPT_BYTES) {
      rejected.push({ name: file.name, reason: "Larger than ~1.5MB" });
    } else if (alreadyQueued + accepted.length >= MAX_BULK_FILES) {
      rejected.push({
        name: file.name,
        reason: `Only ${MAX_BULK_FILES} files per batch`,
      });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

export type ScanStatus = "queued" | "scanning" | "scanned" | "failed";
export type Outcome = "pending" | "saved" | "skipped";

export type QueueItem = {
  id: string;
  scanStatus: ScanStatus;
  outcome: Outcome;
  // Set once saved and the user asked for it to be marked paid.
  paid?: boolean;
  // Set when the expense saved but marking it paid failed.
  paidError?: string | null;
};

// The queued items to start scanning now, in pick order, so that no more than
// `limit` scans are in flight at once.
export function nextToScan(
  items: readonly QueueItem[],
  limit: number = SCAN_CONCURRENCY,
): string[] {
  const running = items.filter((item) => item.scanStatus === "scanning").length;
  const free = Math.max(0, limit - running);
  return items
    .filter((item) => item.scanStatus === "queued")
    .slice(0, free)
    .map((item) => item.id);
}

// A scan has finished (well or badly), so the item can be reviewed.
export function isScanDone(item: QueueItem): boolean {
  return item.scanStatus === "scanned" || item.scanStatus === "failed";
}

// The first item still waiting for the user's decision, or -1 when every
// item has been saved or skipped.
export function nextPendingIndex(items: readonly QueueItem[]): number {
  return items.findIndex((item) => item.outcome === "pending");
}

export function summarize(items: readonly QueueItem[]) {
  const saved = items.filter((item) => item.outcome === "saved");
  return {
    saved: saved.length,
    paid: saved.filter((item) => item.paid && !item.paidError).length,
    paidFailed: saved.filter((item) => item.paidError).length,
    skipped: items.filter((item) => item.outcome === "skipped").length,
    pending: items.filter((item) => item.outcome === "pending").length,
  };
}
