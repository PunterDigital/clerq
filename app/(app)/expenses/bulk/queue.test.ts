import { describe, expect, it } from "vitest";

import {
  MAX_BULK_FILES,
  MAX_RECEIPT_BYTES,
  nextPendingIndex,
  nextToScan,
  partitionFiles,
  summarize,
  type QueueItem,
} from "./queue";

const pdf = (name: string, size = 1000) => ({
  name,
  size,
  type: "application/pdf",
});

describe("partitionFiles", () => {
  it("accepts PNG, JPEG and PDF files within the size cap", () => {
    const files = [
      { name: "a.png", size: 10, type: "image/png" },
      { name: "b.jpg", size: 10, type: "image/jpeg" },
      pdf("c.pdf", MAX_RECEIPT_BYTES),
    ];
    const { accepted, rejected } = partitionFiles(files, 0);
    expect(accepted.map((f) => f.name)).toEqual(["a.png", "b.jpg", "c.pdf"]);
    expect(rejected).toEqual([]);
  });

  it("refuses other types and oversized files with a reason", () => {
    const { accepted, rejected } = partitionFiles(
      [
        { name: "notes.txt", size: 10, type: "text/plain" },
        pdf("huge.pdf", MAX_RECEIPT_BYTES + 1),
      ],
      0,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "notes.txt", reason: "Not a PNG, JPEG or PDF" },
      { name: "huge.pdf", reason: "Larger than ~1.5MB" },
    ]);
  });

  it("caps the batch, counting files queued by earlier picks", () => {
    const files = [pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf")];
    const { accepted, rejected } = partitionFiles(files, MAX_BULK_FILES - 2);
    expect(accepted.map((f) => f.name)).toEqual(["1.pdf", "2.pdf"]);
    expect(rejected).toEqual([
      { name: "3.pdf", reason: `Only ${MAX_BULK_FILES} files per batch` },
    ]);
  });

  it("does not count refused files against the cap", () => {
    const files = [
      { name: "bad.txt", size: 1, type: "text/plain" },
      pdf("ok.pdf"),
    ];
    const { accepted } = partitionFiles(files, MAX_BULK_FILES - 1);
    expect(accepted.map((f) => f.name)).toEqual(["ok.pdf"]);
  });
});

function item(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return { id, scanStatus: "queued", outcome: "pending", ...over };
}

describe("nextToScan", () => {
  it("starts up to the limit, in pick order", () => {
    expect(nextToScan([item("a"), item("b"), item("c")], 2)).toEqual(["a", "b"]);
  });

  it("only fills the free slots", () => {
    const items = [
      item("a", { scanStatus: "scanning" }),
      item("b"),
      item("c"),
    ];
    expect(nextToScan(items, 2)).toEqual(["b"]);
  });

  it("starts nothing while the limit is in flight", () => {
    const items = [
      item("a", { scanStatus: "scanning" }),
      item("b", { scanStatus: "scanning" }),
      item("c"),
    ];
    expect(nextToScan(items, 2)).toEqual([]);
  });

  it("skips finished scans", () => {
    const items = [
      item("a", { scanStatus: "scanned" }),
      item("b", { scanStatus: "failed" }),
      item("c"),
    ];
    expect(nextToScan(items, 2)).toEqual(["c"]);
  });
});

describe("nextPendingIndex", () => {
  it("finds the first item not yet saved or skipped", () => {
    const items = [
      item("a", { outcome: "saved" }),
      item("b", { outcome: "skipped" }),
      item("c"),
    ];
    expect(nextPendingIndex(items)).toBe(2);
  });

  it("is -1 when everything is decided", () => {
    expect(nextPendingIndex([item("a", { outcome: "saved" })])).toBe(-1);
  });
});

describe("summarize", () => {
  it("counts saved, paid, failed-to-mark-paid, skipped and pending", () => {
    const items = [
      item("a", { outcome: "saved", paid: true }),
      item("b", { outcome: "saved", paid: true, paidError: "Forbidden" }),
      item("c", { outcome: "saved" }),
      item("d", { outcome: "skipped" }),
      item("e"),
    ];
    expect(summarize(items)).toEqual({
      saved: 3,
      paid: 1,
      paidFailed: 1,
      skipped: 1,
      pending: 1,
    });
  });
});
