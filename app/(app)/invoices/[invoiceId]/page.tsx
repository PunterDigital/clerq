import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UNIT_CODES } from "@/lib/einvoice-codes";
import { formatDate, formatMoney } from "@/lib/format";
import { minorToMajor } from "@/modules/billing/currency";
import { caller } from "@/server/trpc/server";

import { AddLineForm } from "./add-line-form";
import { CreditNoteDialog } from "./credit-note-dialog";
import { DetailsForm } from "./details-form";
import { GeneratePanel } from "./generate-panel";
import {
  EditLineButton,
  InvoiceActions,
  RemoveLineButton,
} from "./invoice-actions";
import { NotesForm } from "./notes-form";

export const metadata: Metadata = {
  title: "Invoice - Clerq",
};

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  let invoice;
  try {
    invoice = await caller.invoices.get({ invoiceId });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  const [client, projects, business] = await Promise.all([
    caller.clients.get({ clientId: invoice.clientId }),
    caller.projects.list({ clientId: invoice.clientId }),
    caller.business.current(),
  ]);
  const einvoicingEnabled = business?.einvoicingEnabled ?? false;
  // Issued invoices can be exported as Peppol BIS 3.0 XML (#5040); the
  // check runs here so the page can say what's missing instead.
  const einvoice =
    einvoicingEnabled && invoice.status !== "draft" && invoice.status !== "void"
      ? await caller.invoices.einvoice({ invoiceId: invoice.id })
      : null;
  const isDraft = invoice.status === "draft";
  // Credit notes against this invoice and what is left to credit (#5042).
  const credits = isDraft
    ? null
    : await caller.invoices.credits({ invoiceId: invoice.id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl tabular">
              {invoice.number ?? "Draft invoice"}
            </h1>
            <InvoiceStatusPill status={invoice.status} />
          </div>
          <p className="text-muted-foreground">
            <Link
              href={`/clients/${invoice.clientId}`}
              className="underline-offset-4 hover:underline"
            >
              {client.name}
            </Link>
            {!isDraft && invoice.issueDate
              ? ` - issued ${formatDate(invoice.issueDate)}`
              : null}
            {invoice.dueDate ? ` - due ${formatDate(invoice.dueDate)}` : null}
            {invoice.periodStart && invoice.periodEnd
              ? ` - period ${formatDate(invoice.periodStart)} to ${formatDate(invoice.periodEnd)}`
              : null}
            {invoice.buyerReference
              ? ` - PO ${invoice.buyerReference}`
              : null}
          </p>
          {invoice.status === "void" ? (
            <p className="text-sm text-destructive">
              Voided{invoice.voidedAt ? ` ${formatDate(invoice.voidedAt)}` : ""}
              {invoice.voidReason ? ` - ${invoice.voidReason}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          {/* The document exists once issued; drafts are edited, not sent */}
          {invoice.status !== "draft" ? (
            <Button variant="outline" asChild>
              <a href={`/api/invoices/${invoice.id}/pdf`} download>
                Download PDF
              </a>
            </Button>
          ) : null}
          {einvoice?.ok ? (
            <Button variant="outline" asChild>
              <a href={`/api/invoices/${invoice.id}/einvoice`} download>
                Download e-invoice (XML)
              </a>
            </Button>
          ) : null}
          <InvoiceActions
            invoiceId={invoice.id}
            status={invoice.status}
            hasLines={invoice.lines.length > 0}
            canVoid={credits?.canVoid ?? false}
            creditNote={
              credits?.canCredit ? (
                <CreditNoteDialog
                  invoiceId={invoice.id}
                  invoiceNumber={invoice.number}
                  currency={invoice.currency}
                  lines={credits.lines}
                  taxLabel={
                    invoice.taxTreatment === "standard" &&
                    invoice.taxRatePercent !== "0"
                      ? `plus VAT at ${invoice.taxRatePercent}%`
                      : null
                  }
                />
              ) : null
            }
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
            </CardHeader>
            <CardContent>
              {invoice.lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No lines yet - pull in unbilled time below
                </p>
              ) : (
                <ul className="flex flex-col">
                  {invoice.lines.map((line) => (
                    <li
                      key={line.id}
                      className="flex items-start gap-3 border-b py-3 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line text-sm font-medium">
                          {line.description}
                        </p>
                        <p className="text-sm text-muted-foreground tabular">
                          {line.quantity
                            ? `${Number(line.quantity).toFixed(2)} h`
                            : null}
                          {line.quantity && line.unitPriceMinor != null
                            ? " x "
                            : null}
                          {line.unitPriceMinor != null
                            ? `${formatMoney(line.unitPriceMinor, invoice.currency)}/h`
                            : null}
                        </p>
                        {einvoicingEnabled ? (
                          <p className="text-xs text-muted-foreground">
                            Unit:{" "}
                            {UNIT_CODES.find((u) => u.code === line.unitCode)
                              ?.label ?? line.unitCode}{" "}
                            ({line.unitCode})
                          </p>
                        ) : null}
                        {line.sourceCurrency &&
                        line.sourceTotalMinor != null &&
                        line.fxRate ? (
                          <p className="text-xs text-muted-foreground tabular">
                            Converted from{" "}
                            {formatMoney(line.sourceTotalMinor, line.sourceCurrency)}{" "}
                            at {line.fxRate} ({line.fxSource === "ecb" ? "ECB" : "manual"}{" "}
                            rate)
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-sm font-medium tabular">
                        {formatMoney(line.totalMinor, invoice.currency)}
                      </span>
                      {isDraft ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <EditLineButton
                            lineId={line.id}
                            currency={invoice.currency}
                            description={line.description}
                            amount={minorToMajor(
                              line.totalMinor,
                              invoice.currency,
                            )}
                            hasBreakdown={line.quantity != null}
                            unitCode={
                              einvoicingEnabled ? line.unitCode : undefined
                            }
                          />
                          <RemoveLineButton lineId={line.id} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {isDraft ? (
            <>
              <DetailsForm
                invoiceId={invoice.id}
                issueDate={invoice.issueDate}
                dueDate={invoice.dueDate}
                periodStart={invoice.periodStart}
                periodEnd={invoice.periodEnd}
                einvoicing={
                  einvoicingEnabled
                    ? {
                        buyerReference: invoice.buyerReference,
                        vatexCode: invoice.vatexCode,
                        taxTreatment: invoice.taxTreatment,
                      }
                    : null
                }
              />
              <AddLineForm invoiceId={invoice.id} currency={invoice.currency} />
              <GeneratePanel
                invoiceId={invoice.id}
                invoiceCurrency={invoice.currency}
                projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              />
              <NotesForm invoiceId={invoice.id} initialNotes={invoice.notes} />
            </>
          ) : invoice.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-line text-sm text-muted-foreground">
                  {invoice.notes}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          {credits && credits.creditNotes.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Credit notes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col" aria-label="Credit notes">
                  {credits.creditNotes.map((note) => (
                    <li
                      key={note.id}
                      className="flex items-baseline justify-between gap-3 border-b py-2 text-sm last:border-b-0"
                    >
                      <Link
                        href={`/invoices/credit-notes/${note.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {note.number}
                      </Link>
                      <span className="text-muted-foreground">
                        {formatDate(note.issueDate)}
                      </span>
                      <span className="tabular">
                        -{formatMoney(note.totalMinor, invoice.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {credits?.einvoiceSent &&
          (invoice.status === "sent" || invoice.status === "overdue") ? (
            <p className="text-sm text-muted-foreground">
              Sent as an e-invoice, so it can&apos;t be voided: correct it
              with a credit note.
            </p>
          ) : null}
          {einvoice && !einvoice.ok ? (
            <Card>
              <CardHeader>
                <CardTitle>E-invoice</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p className="text-muted-foreground">
                  To download this invoice as an e-invoice (XML), add:
                </p>
                <ul className="list-disc pl-5" aria-label="Missing for the e-invoice">
                  {einvoice.missing.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Totals</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular">
                  {formatMoney(invoice.subtotalMinor, invoice.currency)}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">
                  {invoice.taxTreatment === "standard"
                    ? `VAT ${invoice.taxRatePercent}%`
                    : "VAT"}
                </span>
                <span className="tabular">
                  {formatMoney(invoice.taxMinor, invoice.currency)}
                </span>
              </div>
              <div className="flex items-baseline justify-between border-t pt-2 text-sm font-semibold">
                <span>Total</span>
                <span className="tabular">
                  {formatMoney(invoice.totalMinor, invoice.currency)}
                </span>
              </div>
              {invoice.creditedMinor > 0 ? (
                <>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">Credited</span>
                    <span className="tabular">
                      -{formatMoney(invoice.creditedMinor, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-sm font-semibold">
                    <span>Balance</span>
                    <span className="tabular">
                      {formatMoney(
                        invoice.totalMinor - invoice.creditedMinor,
                        invoice.currency,
                      )}
                    </span>
                  </div>
                </>
              ) : null}
              {invoice.taxNote ? (
                <p className="pt-1 text-xs text-muted-foreground">
                  {invoice.taxNote}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
