import { ReceiptText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { formatDate, formatMoney } from "@/lib/format";
import { caller } from "@/server/trpc/server";

import { InvoiceTabs } from "../invoice-tabs";

export const metadata: Metadata = {
  title: "Credit notes - Clerq",
};

export const dynamic = "force-dynamic";

// Every credit note of the business, newest first (#5042). They are issued
// from an invoice's page ("Issue credit note"), so there's no New button.
export default async function CreditNotesPage() {
  const notes = await caller.invoices.creditNotes();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <h1 className="flex-1 text-2xl">Invoices</h1>
      </div>

      <InvoiceTabs />

      {notes.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border bg-card px-8 py-12 text-center shadow-sm">
          <span className="mb-2.5 flex size-12 items-center justify-center rounded-full bg-[var(--primary-subtle)] text-[var(--primary-subtle-fg)]">
            <ReceiptText className="size-[26px]" aria-hidden />
          </span>
          <h2 className="text-lg font-semibold">No credit notes yet</h2>
          <p className="max-w-[46ch] text-sm text-muted-foreground">
            To correct an issued invoice, open it and choose Issue credit
            note. The credit note gets its own number and cancels all or part
            of the invoice.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          {notes.map((note) => (
            <Link
              key={note.id}
              href={`/invoices/credit-notes/${note.id}`}
              className="flex items-center gap-4 border-b px-4 py-[13px] transition-colors last:border-b-0 hover:bg-muted"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tabular">{note.number}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {note.clientName} - credits {note.invoiceNumber}
                </p>
              </div>
              <span className="text-sm text-muted-foreground">
                {formatDate(note.issueDate)}
              </span>
              <span className="w-28 text-right text-sm font-medium tabular">
                -{formatMoney(note.totalMinor, note.currency)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
