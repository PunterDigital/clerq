import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatMoney } from "@/lib/format";
import { caller } from "@/server/trpc/server";

export const metadata: Metadata = {
  title: "Credit note - Clerq",
};

export const dynamic = "force-dynamic";

export default async function CreditNotePage({
  params,
}: {
  params: Promise<{ creditNoteId: string }>;
}) {
  const { creditNoteId } = await params;
  let note;
  try {
    note = await caller.invoices.creditNote({ creditNoteId });
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST")
    ) {
      notFound();
    }
    throw error;
  }
  const client = await caller.clients.get({ clientId: note.clientId });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl tabular">{note.number}</h1>
            <span className="rounded-full bg-[var(--status-draft-bg)] px-2 py-px text-xs font-semibold text-[var(--status-draft-fg)]">
              Credit note
            </span>
          </div>
          <p className="text-muted-foreground">
            <Link
              href={`/clients/${note.clientId}`}
              className="underline-offset-4 hover:underline"
            >
              {client.name}
            </Link>
            {` - issued ${formatDate(note.issueDate)} - credits `}
            <Link
              href={`/invoices/${note.invoiceId}`}
              className="underline-offset-4 hover:underline"
            >
              invoice {note.invoiceNumber}
            </Link>
          </p>
          {note.reason ? (
            <p className="text-sm text-muted-foreground">Reason: {note.reason}</p>
          ) : null}
        </div>
        <Button variant="outline" asChild>
          <a href={`/api/credit-notes/${note.id}/pdf`} download>
            Download PDF
          </a>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col">
              {note.lines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-start gap-3 border-b py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-line text-sm font-medium">
                      {line.description}
                    </p>
                    {line.quantity && line.unitPriceMinor != null ? (
                      <p className="text-sm text-muted-foreground tabular">
                        {Number(line.quantity).toFixed(2)} h x{" "}
                        {formatMoney(line.unitPriceMinor, note.currency)}/h
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular">
                    {formatMoney(line.totalMinor, note.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular">
                {formatMoney(note.subtotalMinor, note.currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">
                {note.taxTreatment === "standard"
                  ? `VAT ${note.taxRatePercent}%`
                  : "VAT"}
              </span>
              <span className="tabular">
                {formatMoney(note.taxMinor, note.currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between border-t pt-2 text-sm font-semibold">
              <span>Credited</span>
              <span className="tabular">
                {formatMoney(note.totalMinor, note.currency)}
              </span>
            </div>
            {note.taxNote ? (
              <p className="pt-1 text-xs text-muted-foreground">{note.taxNote}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
