"use client";

import { useMutation } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNIT_CODES, type UnitCode } from "@/lib/einvoice-codes";
import { useTRPC } from "@/server/trpc/client";

export function InvoiceActions({
  invoiceId,
  status,
  hasLines,
}: {
  invoiceId: string;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  hasLines: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const issue = useMutation(
    trpc.invoices.issue.mutationOptions({ onSuccess: () => router.refresh() }),
  );
  const markPaid = useMutation(
    trpc.invoices.markPaid.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );

  if (status === "draft") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <DeleteDraftButton invoiceId={invoiceId} />
          <Button
            disabled={!hasLines || issue.isPending}
            onClick={() => issue.mutate({ invoiceId })}
          >
            {issue.isPending ? "Issuing..." : "Issue invoice"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {hasLines
            ? "Issuing assigns the number - it cannot be undone"
            : "Add lines before issuing"}
        </p>
        {issue.error ? (
          <p role="alert" className="text-xs text-destructive">
            {issue.error.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {status === "sent" || status === "overdue" ? (
          <Button
            variant="outline"
            disabled={markPaid.isPending}
            onClick={() => markPaid.mutate({ invoiceId })}
          >
            {markPaid.isPending ? "Recording..." : "Mark as paid"}
          </Button>
        ) : null}
        <DuplicateButton invoiceId={invoiceId} />
      </div>
      {markPaid.error ? (
        <p role="alert" className="text-xs text-destructive">
          {markPaid.error.message}
        </p>
      ) : null}
      {status === "sent" || status === "overdue" ? (
        <VoidControl invoiceId={invoiceId} />
      ) : null}
    </div>
  );
}

// Copies the invoice into a fresh draft and opens it. Available on any issued
// invoice (sent/overdue/paid/void) - re-issue a corrected copy, or reuse a
// past invoice as a starting point.
function DuplicateButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const trpc = useTRPC();
  const duplicate = useMutation(
    trpc.invoices.duplicate.mutationOptions({
      onSuccess: (created) => {
        router.push(`/invoices/${created.id}`);
        router.refresh();
      },
    }),
  );
  return (
    <Button
      variant="outline"
      disabled={duplicate.isPending}
      onClick={() => duplicate.mutate({ invoiceId })}
    >
      {duplicate.isPending ? "Duplicating..." : "Duplicate"}
    </Button>
  );
}

// Deletes a draft for good (drafts aren't documents). Two-step confirm so a
// stray click can't discard work; on success it returns to the invoice list.
function DeleteDraftButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const remove = useMutation(
    trpc.invoices.delete.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        router.push("/invoices");
        router.refresh();
      },
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
        >
          Delete draft
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this draft?</DialogTitle>
          <DialogDescription>
            This permanently deletes the draft. Any time billed on it returns to
            unbilled. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p role="alert" className="text-sm text-destructive">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ invoiceId })}
          >
            {remove.isPending ? "Deleting..." : "Delete draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Voiding keeps the number but closes the invoice out. A short reason can be
// recorded; it shows on the invoice and in the client's activity thread. Two
// steps (reveal, then confirm) so a numbered document is never voided by a
// single stray click.
function VoidControl({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const voidInvoice = useMutation(
    trpc.invoices.void.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let an outside-click/escape dismiss mid-request.
        if (voidInvoice.isPending) return;
        setOpen(next);
        if (!next) {
          setReason("");
          voidInvoice.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
        >
          Void invoice
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void this invoice?</DialogTitle>
          <DialogDescription>
            It keeps its number but no longer counts as revenue. Duplicate it to
            re-issue a corrected copy.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="void-reason">Reason (optional)</Label>
          <textarea
            id="void-reason"
            rows={3}
            placeholder="e.g. client address changed"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          {voidInvoice.error ? (
            <p role="alert" className="text-sm text-destructive">
              {voidInvoice.error.message}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={voidInvoice.isPending}
            onClick={() => {
              setOpen(false);
              setReason("");
              voidInvoice.reset();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={voidInvoice.isPending}
            onClick={() =>
              voidInvoice.mutate({
                invoiceId,
                reason: reason.trim() || undefined,
              })
            }
          >
            {voidInvoice.isPending ? "Voiding..." : "Confirm void"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// In-place edit of a draft line's description and amount. Opens a small dialog
// seeded with the line's current values (so a stray click never loses them) and
// saves through invoices.updateLine. The hours x rate breakdown hint appears
// only for generated lines, where changing the amount replaces that breakdown.
export function EditLineButton({
  lineId,
  currency,
  description: initialDescription,
  amount: initialAmount,
  hasBreakdown,
  unitCode: initialUnitCode,
}: {
  lineId: string;
  currency: string;
  description: string;
  amount: string;
  hasBreakdown: boolean;
  // Set while e-invoicing is on (#5039): shows the UN/ECE unit picker.
  unitCode?: string;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(initialDescription);
  const [amount, setAmount] = useState(initialAmount);
  const [unitCode, setUnitCode] = useState(initialUnitCode ?? "");
  // Only an explicit pick is sent: otherwise a changed amount turns the line
  // into a fixed amount (C62) on the server, like it drops the breakdown.
  const [unitTouched, setUnitTouched] = useState(false);
  const save = useMutation(
    trpc.invoices.updateLine.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        setOpen(next);
        if (next) {
          // Re-seed from the line each time it opens so a cancelled edit never
          // carries into the next one.
          setDescription(initialDescription);
          setAmount(initialAmount);
          setUnitCode(initialUnitCode ?? "");
          setUnitTouched(false);
          save.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Edit line"
          className="size-7 shrink-0"
        >
          <Pencil className="size-4" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({
              lineId,
              description: description.trim(),
              amountMajor: amount.trim(),
              ...(unitTouched && unitCode
                ? { unitCode: unitCode as UnitCode }
                : {}),
            });
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Edit line</DialogTitle>
            <DialogDescription>
              Change this line&apos;s description or amount.
              {hasBreakdown
                ? " Changing the amount replaces its hours x rate breakdown with the amount you enter."
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`edit-line-description-${lineId}`}>
              Description
            </Label>
            <textarea
              id={`edit-line-description-${lineId}`}
              required
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`edit-line-amount-${lineId}`}>
              Amount ({currency})
            </Label>
            <Input
              id={`edit-line-amount-${lineId}`}
              required
              inputMode="decimal"
              placeholder="1500.00"
              className="tabular"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {initialUnitCode !== undefined ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`edit-line-unit-${lineId}`}>Unit</Label>
              <select
                id={`edit-line-unit-${lineId}`}
                value={unitCode}
                onChange={(e) => {
                  setUnitCode(e.target.value);
                  setUnitTouched(true);
                }}
                className="h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {UNIT_CODES.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label} ({u.code})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                The UN/ECE unit code sent in e-invoices.
              </p>
            </div>
          ) : null}
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving..." : "Save line"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveLineButton({ lineId }: { lineId: string }) {
  const router = useRouter();
  const trpc = useTRPC();
  const remove = useMutation(
    trpc.invoices.deleteLine.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Remove line (its time entries return to unbilled)"
      disabled={remove.isPending}
      onClick={() => remove.mutate({ lineId })}
      className="size-7 shrink-0"
    >
      <Trash2 className="size-4" aria-hidden />
    </Button>
  );
}
