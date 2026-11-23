import { zipSync, type Zippable } from "fflate";

import { minorToMajor } from "@/modules/billing/currency";

// Builds the "all receipts for a period" zip: one file per receipt plus a
// summary.csv manifest tying each file back to its expense - the bundle a
// user hands to an accountant. Pure over the queried rows so naming and
// CSV rules are unit-testable without a database.

export type ReceiptRow = {
  id: string;
  description: string;
  amountMinor: number;
  currency: string;
  vendor: string | null;
  category: string | null;
  status: string;
  incurredAt: Date;
  receiptDataUrl: string | null;
  receiptFilename: string | null;
  receiptMimeType: string | null;
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Uploaded filenames are user-supplied: strip directory separators and
// characters that are unsafe in zip entries or on common filesystems, and
// keep the stem short so the date prefix stays readable.
function sanitizeStem(name: string): string {
  const stem = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return stem.slice(0, 80).trim();
}

// "2026-07-14 adobe-invoice.pdf"; falls back to the expense description
// when the upload had no usable name. Collisions get " (2)", " (3)", ...
export function receiptEntryName(
  row: ReceiptRow,
  taken: Set<string>,
): string {
  const ext =
    EXTENSION_BY_MIME[row.receiptMimeType ?? ""] ??
    row.receiptFilename?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ??
    "bin";
  const stem =
    sanitizeStem(row.receiptFilename ?? "") ||
    sanitizeStem(row.description) ||
    "receipt";
  const base = `${isoDate(row.incurredAt)} ${stem}`;
  let name = `${base}.${ext}`;
  for (let n = 2; taken.has(name); n += 1) {
    name = `${base} (${n}).${ext}`;
  }
  taken.add(name);
  return name;
}

// A cell starting with = + - @ (or a tab / CR) is run as a formula by
// Excel and friends: prefix it with ' so it stays text (#5584). Plain
// numbers (a negative amount) are left alone.
function defuseFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function csvCell(raw: string): string {
  const value = defuseFormula(raw);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function receiptsSummaryCsv(
  entries: { row: ReceiptRow; name: string }[],
): string {
  const header = [
    "date",
    "description",
    "vendor",
    "category",
    "amount",
    "currency",
    "status",
    "file",
  ];
  const lines = entries.map(({ row, name }) =>
    [
      isoDate(row.incurredAt),
      row.description,
      row.vendor ?? "",
      row.category ?? "",
      minorToMajor(row.amountMinor, row.currency),
      row.currency,
      row.status,
      name,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

// The stored data URL's base64 payload, decoded. Rows come from a query
// that filters on receipt_data_url IS NOT NULL, so a missing payload here
// means a malformed row - skip it rather than corrupt the archive.
function receiptBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  try {
    return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), "base64"));
  } catch {
    return null;
  }
}

export function buildReceiptsArchive(rows: ReceiptRow[]): Uint8Array {
  const taken = new Set<string>();
  const entries: { row: ReceiptRow; name: string }[] = [];
  const files: Zippable = {};

  for (const row of rows) {
    if (!row.receiptDataUrl) continue;
    const bytes = receiptBytes(row.receiptDataUrl);
    if (!bytes) continue;
    const name = receiptEntryName(row, taken);
    entries.push({ row, name });
    // PNG/JPEG/PDF payloads are already compressed - store them as-is
    // instead of burning CPU deflating bytes that won't shrink.
    files[name] = [bytes, { level: 0 }];
  }

  files["summary.csv"] = [
    new TextEncoder().encode(receiptsSummaryCsv(entries)),
    { level: 6 },
  ];

  return zipSync(files);
}
