"use client";

import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  majorToMinor,
  minorToMajor,
  minorUnitDigits,
} from "@/modules/billing/currency";
import type { ReceiptScanResult } from "@/modules/expenses/ocr";
import { useTRPC } from "@/server/trpc/client";

import { TagPicker } from "./tag-picker";

// Mirror the receipt cap the server enforces, so we can warn before encoding
// rather than after a rejected mutation.
const MAX_RECEIPT_BYTES = 1_500_000;
const RECEIPT_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
type ReceiptMime = (typeof RECEIPT_TYPES)[number];

// What the date input wants: YYYY-MM-DD in the local timezone.
function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ExpenseInitial = {
  id: string;
  description: string;
  amountMinor: number;
  currency: string;
  vendor: string | null;
  category: string | null;
  incurredAt: Date;
  notes: string | null;
  receiptFilename: string | null;
  tagIds: string[];
};

export type NewReceipt = {
  dataUrl: string;
  filename: string;
  mimeType: ReceiptMime;
};

// Review mode, used by bulk upload: the form starts from a scanned receipt
// (already attached), saves without leaving the page and hands control back
// to the caller, which moves on to the next file.
export type ExpenseReview = {
  // The file to attach, or null when it couldn't be read.
  receipt: NewReceipt | null;
  // What the scan read, or null when it failed.
  prefill: ReceiptScanResult | null;
  scanError: string | null;
  // Whether to offer "Mark as paid" (the caller holds expenses.approve).
  canMarkPaid: boolean;
  isLast: boolean;
  onSaved: (result: {
    expenseId: string;
    paid: boolean;
    paidError: string | null;
  }) => void;
  onSkip: () => void;
};

export function ExpenseForm({
  initial,
  defaultCurrency,
  scanEnabled = false,
  review,
}: {
  initial?: ExpenseInitial;
  defaultCurrency: string;
  // True when the instance has OpenRouter receipt scanning configured. When
  // false the "Scan with AI" button is never shown.
  scanEnabled?: boolean;
  review?: ExpenseReview;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const fileInput = useRef<HTMLInputElement>(null);

  const prefill = review?.prefill ?? null;
  const startCurrency = initial?.currency ?? prefill?.currency ?? defaultCurrency;

  const [description, setDescription] = useState(
    initial?.description ?? prefill?.description ?? "",
  );
  const [currency, setCurrency] = useState(startCurrency);
  const [amount, setAmount] = useState(
    initial
      ? minorToMajor(initial.amountMinor, initial.currency)
      : prefill?.amount != null
        ? prefill.amount.toFixed(minorUnitDigits(startCurrency))
        : "",
  );
  const [incurredAt, setIncurredAt] = useState(
    // The scan's date is already YYYY-MM-DD - exactly what the input takes.
    prefill?.date ?? toDateInput(initial?.incurredAt ?? new Date()),
  );
  const [vendor, setVendor] = useState(initial?.vendor ?? prefill?.vendor ?? "");
  const [category, setCategory] = useState(
    initial?.category ?? prefill?.category ?? "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? prefill?.notes ?? "");
  const [tagIds, setTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [markPaid, setMarkPaid] = useState(false);

  // Receipt state machine: "keep" (untouched), a new file, or "remove".
  const [receipt, setReceipt] = useState<NewReceipt | "keep" | "remove">(
    review?.receipt ?? "keep",
  );
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const create = useMutation(
    trpc.expenses.create.mutationOptions({
      onSuccess: (created) => {
        // Review mode saves in place; the caller moves on (see submit).
        if (review) return;
        router.push(`/expenses/${created.id}`);
        router.refresh();
      },
    }),
  );
  const setStatus = useMutation(trpc.expenses.setStatus.mutationOptions());
  const update = useMutation(
    trpc.expenses.update.mutationOptions({
      onSuccess: () => {
        router.push(`/expenses/${initial!.id}`);
        router.refresh();
      },
    }),
  );
  const mutation = initial ? update : create;

  // True while a PDF receipt is being rasterized to an image before scanning.
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  // Receipt scanning: hand the picked image to the vision model and pre-fill
  // whatever it confidently reads. Only non-null fields overwrite the form, so
  // a partial read never wipes something the user already typed.
  const scan = useMutation(
    trpc.expenses.scanReceipt.mutationOptions({
      onSuccess: (result) => {
        if (result.description) setDescription(result.description);
        const nextCurrency = result.currency ?? currency;
        if (result.currency) setCurrency(result.currency);
        if (result.amount !== null) {
          setAmount(result.amount.toFixed(minorUnitDigits(nextCurrency)));
        }
        if (result.vendor) setVendor(result.vendor);
        if (result.category) setCategory(result.category);
        // Already YYYY-MM-DD - exactly what the date input takes.
        if (result.date) setIncurredAt(result.date);
        if (result.notes) setNotes(result.notes);
      },
    }),
  );

  // Kick off a scan for the freshly picked receipt. Images go straight to the
  // scan endpoint; PDFs are rasterized to a JPEG in the browser first, since
  // the vision model reads images, not PDFs.
  async function runScan(picked: NewReceipt) {
    setConvertError(null);
    if (picked.mimeType !== "application/pdf") {
      scan.mutate({ dataUrl: picked.dataUrl, mimeType: picked.mimeType });
      return;
    }
    setConverting(true);
    try {
      const { pdfFirstPageToImage } = await import("@/lib/pdf-to-image");
      const image = await pdfFirstPageToImage(picked.dataUrl);
      scan.mutate(image);
    } catch {
      setConvertError(
        "Could not read that PDF - try uploading a PNG or JPEG instead.",
      );
    } finally {
      setConverting(false);
    }
  }

  const currencyOk = /^[A-Za-z]{3}$/.test(currency);
  const amountMinor = currencyOk ? majorToMinor(amount, currency) : null;
  const amountOk = amountMinor !== null && amountMinor > 0;

  function onPickReceipt(file: File | undefined) {
    setReceiptError(null);
    if (!file) return;
    if (!RECEIPT_TYPES.includes(file.type as ReceiptMime)) {
      setReceiptError("Receipt must be a PNG, JPEG or PDF");
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      setReceiptError("Receipt is too large - keep it under ~1.5MB");
      return;
    }
    // A different receipt invalidates any prior scan result/error.
    scan.reset();
    setConvertError(null);
    const reader = new FileReader();
    reader.onload = () =>
      setReceipt({
        dataUrl: reader.result as string,
        filename: file.name,
        mimeType: file.type as ReceiptMime,
      });
    reader.onerror = () => setReceiptError("Could not read that file");
    reader.readAsDataURL(file);
  }

  function clearReceipt() {
    setReceipt(initial?.receiptFilename ? "remove" : "keep");
    setReceiptError(null);
    scan.reset();
    setConvertError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  // Translate the receipt state into the field the API expects: undefined
  // keeps the stored receipt, null clears it, an object replaces it.
  function receiptInput(): NewReceipt | null | undefined {
    if (receipt === "keep") return undefined;
    if (receipt === "remove") return null;
    return receipt;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!amountOk || amountMinor === null) return;
    const data = {
      description: description.trim(),
      amountMinor,
      currency: currency.toUpperCase(),
      vendor: vendor.trim() || null,
      category: category.trim() || null,
      incurredAt: new Date(`${incurredAt}T00:00:00`),
      notes: notes.trim() || null,
      receipt: receiptInput(),
      tagIds,
    };
    if (initial) {
      update.mutate({ expenseId: initial.id, data });
    } else if (review) {
      void saveForReview(data);
    } else {
      create.mutate(data);
    }
  }

  // Review mode: create, then mark paid if asked. A failed create stays on
  // this item (the error shows below the form); a failed "mark paid" still
  // counts as saved, and the caller reports it at the end.
  async function saveForReview(data: Parameters<typeof create.mutate>[0]) {
    if (!review) return;
    let expenseId: string;
    try {
      expenseId = (await create.mutateAsync(data)).id;
    } catch {
      return;
    }
    let paidError: string | null = null;
    const paid = review.canMarkPaid && markPaid;
    if (paid) {
      try {
        await setStatus.mutateAsync({ expenseId, status: "paid" });
      } catch (error) {
        paidError =
          error instanceof Error ? error.message : "Could not mark it paid";
      }
    }
    review.onSaved({ expenseId, paid, paidError });
  }

  const pickedFilename =
    receipt !== "keep" && receipt !== "remove" ? receipt.filename : null;
  const showsStoredReceipt = receipt === "keep" && initial?.receiptFilename;

  // Scanning needs a freshly picked receipt in hand (we send its bytes). The
  // stored-receipt case has no client-side bytes to scan. PNG/JPEG go straight
  // up; PDFs are rasterized to an image at scan time (see runScan).
  const scannableReceipt =
    scanEnabled && receipt !== "keep" && receipt !== "remove" ? receipt : null;
  const scanBusy = converting || scan.isPending;

  return (
    <Card>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              required
              maxLength={500}
              placeholder="Adobe Creative Cloud subscription"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                required
                inputMode="decimal"
                placeholder="49.99"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="flex w-24 flex-col gap-2">
              <Label htmlFor="currency">Currency</Label>
              <Input
                id="currency"
                required
                maxLength={3}
                className="uppercase"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          {amount && !amountOk ? (
            <p role="alert" className="-mt-3 text-sm text-destructive">
              Enter a valid amount for {currency.toUpperCase()} (e.g. 49.99)
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="incurredAt">Date</Label>
            <Input
              id="incurredAt"
              type="date"
              required
              value={incurredAt}
              onChange={(e) => setIncurredAt(e.target.value)}
              className="w-48"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="vendor">Vendor (optional)</Label>
              <Input
                id="vendor"
                maxLength={200}
                placeholder="Adobe"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="category">Category (optional)</Label>
              <Input
                id="category"
                maxLength={100}
                placeholder="Software"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label id="tags-label">Tags (optional)</Label>
            <TagPicker value={tagIds} onChange={setTagIds} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="receipt">Receipt (optional)</Label>
            <input
              id="receipt"
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              onChange={(e) => onPickReceipt(e.target.files?.[0])}
              className="text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-accent"
            />
            {pickedFilename ? (
              <p className="text-sm text-muted-foreground">
                Attaching <span className="font-medium">{pickedFilename}</span>
                {" · "}
                <button
                  type="button"
                  onClick={clearReceipt}
                  className="underline-offset-4 hover:underline"
                >
                  remove
                </button>
              </p>
            ) : showsStoredReceipt ? (
              <p className="text-sm text-muted-foreground">
                Current: <span className="font-medium">{initial.receiptFilename}</span>
                {" · "}
                <button
                  type="button"
                  onClick={() => setReceipt("remove")}
                  className="underline-offset-4 hover:underline"
                >
                  remove
                </button>
              </p>
            ) : receipt === "remove" ? (
              <p className="text-sm text-muted-foreground">
                Receipt will be removed.{" "}
                <button
                  type="button"
                  onClick={() => setReceipt("keep")}
                  className="underline-offset-4 hover:underline"
                >
                  undo
                </button>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                PNG, JPEG or PDF, up to ~1.5MB.
              </p>
            )}
            {receiptError ? (
              <p role="alert" className="text-sm text-destructive">
                {receiptError}
              </p>
            ) : null}

            {scannableReceipt ? (
              <div className="flex flex-col gap-2 pt-1">
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={scanBusy}
                    onClick={() => runScan(scannableReceipt)}
                  >
                    <Sparkles className="size-4" />
                    {converting
                      ? "Reading PDF..."
                      : scan.isPending
                        ? "Scanning..."
                        : "Scan with AI"}
                  </Button>
                </div>
                {convertError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {convertError}
                  </p>
                ) : review && scan.isIdle && review.prefill ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Fields filled in from the receipt - check them before saving.
                  </p>
                ) : review && scan.isIdle && review.scanError ? (
                  <p role="alert" className="text-sm text-destructive">
                    Could not scan this file ({review.scanError}). Fill in the
                    details by hand, or try scanning again.
                  </p>
                ) : scan.isSuccess ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Fields filled in from the receipt - check them before saving.
                  </p>
                ) : scan.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {scan.error.message}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Read this receipt and fill in the fields automatically.
                  </p>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <textarea
              id="notes"
              rows={2}
              maxLength={10_000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
          </div>

          {review?.canMarkPaid ? (
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={markPaid}
                onChange={(e) => setMarkPaid(e.target.checked)}
                className="size-4"
              />
              Mark as paid
            </label>
          ) : null}

          {mutation.error ? (
            <p role="alert" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          ) : null}

          {review ? (
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  setStatus.isPending ||
                  !amountOk ||
                  !currencyOk
                }
              >
                {create.isPending || setStatus.isPending
                  ? "Saving..."
                  : review.isLast
                    ? "Save and finish"
                    : "Save and next"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={create.isPending || setStatus.isPending}
                onClick={review.onSkip}
              >
                Skip
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={mutation.isPending || !amountOk || !currencyOk}
              >
                {initial
                  ? mutation.isPending
                    ? "Saving..."
                    : "Save changes"
                  : mutation.isPending
                    ? "Adding..."
                    : "Add expense"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
