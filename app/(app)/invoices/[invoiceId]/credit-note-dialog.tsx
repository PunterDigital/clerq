"use client";

import { useMutation } from "@tanstack/react-query";
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
import { formatMoney } from "@/lib/format";
import { majorToMinor, minorToMajor } from "@/modules/billing/currency";
import { useTRPC } from "@/server/trpc/client";

type Line = {
  invoiceLineId: string;
  description: string;
  remainingMinor: number;
};

// "Issue credit note" (#5042): every line that still has something left is
// listed, ticked, with its remaining amount. Leave it as is for a full
// credit, or untick lines / lower amounts for a partial one. VAT follows
// the invoice and is worked out on the server.
export function CreditNoteDialog({
  invoiceId,
  invoiceNumber,
  currency,
  lines,
  taxLabel,
}: {
  invoiceId: string;
  invoiceNumber: string | null;
  currency: string;
  lines: Line[];
  // e.g. "plus VAT at 21%" for standard-rate invoices; null otherwise.
  taxLabel: string | null;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const open_ = lines.filter((l) => l.remainingMinor > 0);
  const initial = () =>
    Object.fromEntries(
      open_.map((l) => [
        l.invoiceLineId,
        { checked: true, amount: minorToMajor(l.remainingMinor, currency) },
      ]),
    );
  const [open, setOpen] = useState(false);
  const [picks, setPicks] =
    useState<Record<string, { checked: boolean; amount: string }>>(initial);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const issue = useMutation(
    trpc.invoices.issueCreditNote.mutationOptions({
      onSuccess: (note) => {
        setOpen(false);
        router.push(`/invoices/credit-notes/${note.id}`);
        router.refresh();
      },
    }),
  );

  const chosen = open_.filter((l) => picks[l.invoiceLineId]?.checked);
  const subtotalMinor = chosen.reduce((total, l) => {
    const minor = majorToMinor(picks[l.invoiceLineId].amount, currency);
    return total + (minor ?? 0);
  }, 0);

  function reset() {
    setPicks(initial());
    setReason("");
    setFormError(null);
    issue.reset();
  }

  function submit() {
    setFormError(null);
    const lines = [];
    let full = chosen.length === open_.length;
    for (const l of chosen) {
      const minor = majorToMinor(picks[l.invoiceLineId].amount, currency);
      if (minor === null || minor <= 0) {
        setFormError(`Enter an amount above zero for "${firstLine(l.description)}"`);
        return;
      }
      if (minor > l.remainingMinor) {
        setFormError(
          `"${firstLine(l.description)}" has only ${formatMoney(l.remainingMinor, currency)} left to credit`,
        );
        return;
      }
      if (minor !== l.remainingMinor) {
        full = false;
      }
      lines.push({
        invoiceLineId: l.invoiceLineId,
        amountMajor: picks[l.invoiceLineId].amount.trim(),
      });
    }
    if (lines.length === 0) {
      setFormError("Tick at least one line to credit");
      return;
    }
    issue.mutate({
      invoiceId,
      // A full credit sends no lines: the server credits everything left.
      lines: full ? undefined : lines,
      reason: reason.trim() || undefined,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (issue.isPending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Issue credit note</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Credit invoice {invoiceNumber}</DialogTitle>
          <DialogDescription>
            A credit note gets its own number and cancels all or part of this
            invoice. Leave every line ticked to credit it in full.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3" aria-label="Lines to credit">
          {open_.map((line) => {
            const pick = picks[line.invoiceLineId];
            const id = `credit-${line.invoiceLineId}`;
            return (
              <li key={line.invoiceLineId} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-2.5"
                  aria-label={`Credit ${firstLine(line.description)}`}
                  checked={pick.checked}
                  onChange={(e) =>
                    setPicks({
                      ...picks,
                      [line.invoiceLineId]: { ...pick, checked: e.target.checked },
                    })
                  }
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Label htmlFor={id} className="whitespace-pre-line">
                    {line.description}
                  </Label>
                  <p className="text-xs text-muted-foreground tabular">
                    Up to {formatMoney(line.remainingMinor, currency)}
                  </p>
                </div>
                <Input
                  id={id}
                  className="w-32 tabular"
                  inputMode="decimal"
                  disabled={!pick.checked}
                  value={pick.amount}
                  onChange={(e) =>
                    setPicks({
                      ...picks,
                      [line.invoiceLineId]: { ...pick, amount: e.target.value },
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
        <p className="text-sm tabular">
          Credit: <span className="font-semibold">{formatMoney(subtotalMinor, currency)}</span>
          {taxLabel ? ` ${taxLabel}` : ""}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="credit-reason">Reason (printed on the credit note)</Label>
          <textarea
            id="credit-reason"
            rows={2}
            placeholder="e.g. wrong hourly rate"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
        </div>
        {formError || issue.error ? (
          <p role="alert" className="text-sm text-destructive">
            {formError ?? issue.error?.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={issue.isPending}
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button disabled={issue.isPending} onClick={submit}>
            {issue.isPending ? "Issuing..." : "Issue credit note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function firstLine(text: string): string {
  return text.split("\n")[0];
}
