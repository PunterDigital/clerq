"use client";

import { CheckCircle2, FileUp, Loader2, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReceiptScanResult } from "@/modules/expenses/ocr";
import { useTRPCClient } from "@/server/trpc/client";

import { ExpenseForm, type NewReceipt } from "../expense-form";
import {
  isScanDone,
  MAX_BULK_FILES,
  nextPendingIndex,
  nextToScan,
  partitionFiles,
  summarize,
  type QueueItem,
  type ReceiptMime,
  type RejectedFile,
} from "./queue";

type Item = QueueItem & {
  file: File;
  // A blob: URL for the preview next to the form.
  previewUrl: string;
  receipt: NewReceipt | null;
  scan: ReceiptScanResult | null;
  scanError: string | null;
  expenseId?: string;
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

let nextId = 0;

export function BulkUpload({
  defaultCurrency,
  canMarkPaid,
}: {
  defaultCurrency: string;
  canMarkPaid: boolean;
}) {
  const router = useRouter();
  const trpcClient = useTRPCClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [phase, setPhase] = useState<"pick" | "review" | "done">("pick");
  const [dragging, setDragging] = useState(false);
  // Guards against starting a scan twice (React runs effects twice in dev).
  const started = useRef(new Set<string>());

  function patch(id: string, change: Partial<Item>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }

  // Read one file, turn a PDF's first page into an image, and scan it.
  async function scanOne(item: Item) {
    let receipt: NewReceipt;
    try {
      receipt = {
        dataUrl: await readAsDataUrl(item.file),
        filename: item.file.name,
        mimeType: item.file.type as ReceiptMime,
      };
    } catch {
      patch(item.id, { scanStatus: "failed", scanError: "Could not read that file" });
      return;
    }
    patch(item.id, { receipt });
    try {
      let image: { dataUrl: string; mimeType: "image/png" | "image/jpeg" };
      if (receipt.mimeType === "application/pdf") {
        const { pdfFirstPageToImage } = await import("@/lib/pdf-to-image");
        try {
          image = await pdfFirstPageToImage(receipt.dataUrl);
        } catch {
          throw new Error("could not read the PDF");
        }
      } else {
        image = { dataUrl: receipt.dataUrl, mimeType: receipt.mimeType };
      }
      const scan = await trpcClient.expenses.scanReceipt.mutate(image);
      patch(item.id, { scanStatus: "scanned", scan, scanError: null });
    } catch (error) {
      patch(item.id, {
        scanStatus: "failed",
        scanError: error instanceof Error ? error.message : "scan failed",
      });
    }
  }

  // Keep up to SCAN_CONCURRENCY scans running until the queue is empty.
  useEffect(() => {
    const ids = nextToScan(items).filter((id) => !started.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) started.current.add(id);
    setItems((current) =>
      current.map((item) =>
        ids.includes(item.id) ? { ...item, scanStatus: "scanning" } : item,
      ),
    );
    for (const id of ids) {
      const item = items.find((candidate) => candidate.id === id);
      if (item) void scanOne(item);
    }
    // scanOne only uses stable setters and the tRPC client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Free the preview blob URLs when the page goes away.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

  // Closing or reloading the tab with items still to review asks first.
  const unsaved = phase !== "done" && items.some((item) => item.outcome === "pending");
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const { accepted, rejected: refused } = partitionFiles(
      Array.from(list),
      items.length,
    );
    setRejected(refused);
    setItems((current) => [
      ...current,
      ...accepted.map((file) => ({
        id: `f${++nextId}`,
        file,
        previewUrl: URL.createObjectURL(file),
        receipt: null,
        scan: null,
        scanError: null,
        scanStatus: "queued" as const,
        outcome: "pending" as const,
      })),
    ]);
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeItem(id: string) {
    setItems((current) => {
      const gone = current.find((item) => item.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function decide(id: string, change: Partial<Item>) {
    const updated = items.map((item) =>
      item.id === id ? { ...item, ...change } : item,
    );
    setItems(updated);
    if (nextPendingIndex(updated) === -1) {
      setPhase("done");
      router.refresh();
    }
  }

  if (phase === "done") {
    return <Summary items={items} onRestart={() => {
      for (const item of items) URL.revokeObjectURL(item.previewUrl);
      started.current.clear();
      setItems([]);
      setRejected([]);
      setPhase("pick");
    }} />;
  }

  if (phase === "review") {
    const index = nextPendingIndex(items);
    const current = items[index];
    const reviewed = items.filter((item) => item.outcome !== "pending").length;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <p className="flex-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Expense {reviewed + 1} of {items.length}
            </span>
            {" · "}
            {current.file.name}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                window.confirm(
                  "Stop reviewing? Expenses you haven't saved yet will not be added.",
                )
              ) {
                setPhase("done");
                router.refresh();
              }
            }}
          >
            Stop
          </Button>
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]">
          {isScanDone(current) ? (
            <ExpenseForm
              key={current.id}
              defaultCurrency={defaultCurrency}
              scanEnabled
              review={{
                // A file that couldn't even be read has no receipt to attach.
                receipt: current.receipt,
                prefill: current.scan,
                scanError: current.scanError,
                canMarkPaid,
                isLast:
                  items.filter((item) => item.outcome === "pending").length === 1,
                onSaved: ({ expenseId, paid, paidError }) =>
                  decide(current.id, {
                    outcome: "saved",
                    expenseId,
                    paid,
                    paidError,
                  }),
                onSkip: () => decide(current.id, { outcome: "skipped" }),
              }}
            />
          ) : (
            <Card>
              <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span role="status">Scanning {current.file.name}...</span>
              </CardContent>
            </Card>
          )}
          <Preview item={current} />
        </div>
      </div>
    );
  }

  const ready = items.filter(isScanDone).length;
  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor="bulk-files"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-6 py-10 text-center shadow-sm transition-colors hover:bg-accent/40",
          dragging && "border-primary bg-accent/40",
        )}
      >
        <FileUp className="size-6 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">
          Drop files here, or click to choose
        </span>
        <span className="text-xs text-muted-foreground">
          PNG, JPEG or PDF, up to ~1.5MB each, {MAX_BULK_FILES} per batch
        </span>
        <input
          id="bulk-files"
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,application/pdf"
          aria-label="Receipt files"
          className="sr-only"
          onChange={(event) => addFiles(event.target.files)}
        />
      </label>

      {rejected.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {rejected.map((file, i) => (
            <p key={`${file.name}-${i}`}>
              {file.name}: {file.reason}
            </p>
          ))}
        </div>
      ) : null}

      {items.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <ul className="flex flex-col divide-y" aria-label="Files">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
                  <ScanBadge item={item} />
                  <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.scanStatus === "queued"
                      ? "Waiting"
                      : item.scanStatus === "scanning"
                        ? "Scanning..."
                        : item.scanStatus === "scanned"
                          ? "Scanned"
                          : "Scan failed"}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${item.file.name}`}
                    disabled={item.scanStatus === "scanning"}
                    onClick={() => removeItem(item.id)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={items.length === 0 || !isScanDone(items[0])}
          onClick={() => setPhase("review")}
        >
          Review {items.length === 1 ? "1 expense" : `${items.length} expenses`}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link href="/expenses">Cancel</Link>
        </Button>
        {items.length > 0 ? (
          <span className="text-sm text-muted-foreground" role="status">
            {ready} of {items.length} scanned
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ScanBadge({ item }: { item: QueueItem }) {
  if (item.scanStatus === "scanned") {
    return <CheckCircle2 className="size-4 text-success" aria-hidden />;
  }
  if (item.scanStatus === "failed") {
    return <XCircle className="size-4 text-destructive" aria-hidden />;
  }
  return (
    <Loader2
      className={cn(
        "size-4 text-muted-foreground",
        item.scanStatus === "scanning" && "animate-spin",
      )}
      aria-hidden
    />
  );
}

function Preview({ item }: { item: Item }) {
  const isPdf = item.file.type === "application/pdf";
  return (
    <div className="min-h-[24rem] overflow-hidden rounded-lg border bg-card shadow-sm">
      {isPdf ? (
        <iframe
          src={item.previewUrl}
          title={`Preview of ${item.file.name}`}
          className="h-[70vh] w-full"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview
        <img
          src={item.previewUrl}
          alt={`Preview of ${item.file.name}`}
          className="mx-auto max-h-[70vh] object-contain"
        />
      )}
    </div>
  );
}

function Summary({
  items,
  onRestart,
}: {
  items: Item[];
  onRestart: () => void;
}) {
  const totals = summarize(items);
  const saved = items.filter((item) => item.outcome === "saved");
  const failedPaid = saved.filter((item) => item.paidError);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        <p role="status" className="text-sm">
          <span className="font-medium">
            Saved {totals.saved} {totals.saved === 1 ? "expense" : "expenses"}
          </span>
          {totals.paid > 0 ? ` (${totals.paid} marked paid)` : ""}
          {totals.skipped > 0 ? `, skipped ${totals.skipped}` : ""}
          {totals.pending > 0 ? `, ${totals.pending} not reviewed` : ""}.
        </p>
        {failedPaid.length > 0 ? (
          <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
            {failedPaid.map((item) => (
              <p key={item.id}>
                {item.file.name} was saved but not marked paid: {item.paidError}
              </p>
            ))}
          </div>
        ) : null}
        {saved.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {saved.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/expenses/${item.expenseId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {item.file.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/expenses">Back to expenses</Link>
          </Button>
          <Button type="button" variant="outline" onClick={onRestart}>
            Upload more
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
