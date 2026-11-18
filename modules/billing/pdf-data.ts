// View model for the invoice PDF: every string the document renders,
// built here so it is unit-testable without rendering. The PDF layer
// only lays out what this produces.

import { formatIban } from "@/lib/einvoice-codes";
import { formatDateFull, formatMoney, formatMoneyCode } from "@/lib/format";

// Postal addresses are stored verbatim, newline-separated; the PDF lays
// them out one line per row, trimmed and with blank lines dropped.
function addressLines(address: string | null | undefined): string[] {
  return address
    ? address
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

type InvoiceRecord = {
  number: string | null;
  status: "draft" | "sent" | "paid" | "overdue" | "void" | "credited";
  currency: string;
  issueDate: Date | null;
  dueDate: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  taxTreatment: "standard" | "zero_rated" | "reverse_charge";
  taxRatePercent: string;
  taxNote: string | null;
  buyerReference?: string | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  notes: string | null;
  lines: {
    description: string;
    quantity: string | null;
    unitPriceMinor: number | null;
    totalMinor: number;
    sourceCurrency: string | null;
    sourceTotalMinor: number | null;
    fxRate: string | null;
    fxSource: "ecb" | "manual" | null;
  }[];
};

// The teal the invoice has always used; the brand colour falls back to it
// so an un-branded business looks exactly as before.
export const DEFAULT_BRAND_COLOR = "#228E80";

export type InvoicePdfData = {
  title: string;
  isDraft: boolean;
  isPaid: boolean;
  isVoid: boolean;
  brandColor: string;
  logoDataUrl: string | null;
  footerNote: string | null;
  businessName: string;
  businessAddressLines: string[];
  businessVatNumber: string | null;
  clientName: string;
  clientAddressLines: string[];
  clientCompanyNumber: string | null;
  clientVatNumber: string | null;
  issueDateLabel: string | null;
  dueDateLabel: string | null;
  periodLabel: string | null;
  // The client's PO number / buyer reference, when the invoice has one.
  buyerReference: string | null;
  lines: {
    description: string;
    quantityLabel: string | null;
    totalLabel: string;
    conversionNote: string | null;
  }[];
  subtotalLabel: string;
  taxRowLabel: string;
  taxAmountLabel: string;
  totalLabel: string;
  // The headline amount due, shown prominently as "Balance Due" in the PDF
  // header, formatted with the currency code after it ("10,000.00 EUR").
  balanceDueLabel: string;
  // Caption over that amount: "Balance Due", or "Amount Credited" on a
  // credit note (#5042).
  balanceCaption: string;
  // On a credit note: the invoice it credits ("2026-0012 of 3 March 2026").
  creditsInvoiceLabel: string | null;
  taxNote: string | null;
  notes: string | null;
  // "IBAN DE89 3704 ..." / "BIC COBADEFFXXX" rows under Payment details;
  // empty when the business has no bank details set.
  paymentLines: string[];
};

export function buildInvoicePdfData(input: {
  invoice: InvoiceRecord;
  business: {
    name: string;
    address: string | null;
    vatNumber: string | null;
    brandColor?: string | null;
    logoDataUrl?: string | null;
    footerNote?: string | null;
    iban?: string | null;
    bic?: string | null;
  };
  client: {
    name: string;
    address: string | null;
    companyNumber: string | null;
    vatNumber: string | null;
  };
}): InvoicePdfData {
  const { invoice, business, client } = input;
  const isDraft = invoice.status === "draft";

  return {
    title: isDraft ? "Draft invoice" : `Invoice ${invoice.number}`,
    isDraft,
    isPaid: invoice.status === "paid",
    isVoid: invoice.status === "void",
    brandColor: business.brandColor || DEFAULT_BRAND_COLOR,
    logoDataUrl: business.logoDataUrl ?? null,
    footerNote: business.footerNote ?? null,
    businessName: business.name,
    businessAddressLines: addressLines(business.address),
    businessVatNumber: business.vatNumber,
    clientName: client.name,
    clientAddressLines: addressLines(client.address),
    clientCompanyNumber: client.companyNumber,
    clientVatNumber: client.vatNumber,
    issueDateLabel: invoice.issueDate
      ? formatDateFull(invoice.issueDate)
      : null,
    dueDateLabel: invoice.dueDate ? formatDateFull(invoice.dueDate) : null,
    // Both dates are set together (the form requires the pair), so a single
    // range label is enough; guard on both for safety.
    periodLabel:
      invoice.periodStart && invoice.periodEnd
        ? `${formatDateFull(invoice.periodStart)} - ${formatDateFull(
            invoice.periodEnd,
          )}`
        : null,
    buyerReference: invoice.buyerReference || null,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantityLabel:
        line.quantity !== null && line.unitPriceMinor !== null
          ? `${Number(line.quantity).toFixed(2)} h x ${formatMoney(
              line.unitPriceMinor,
              invoice.currency,
            )}/h`
          : null,
      totalLabel: formatMoney(line.totalMinor, invoice.currency),
      conversionNote:
        line.sourceCurrency && line.sourceTotalMinor !== null && line.fxRate
          ? `Converted from ${formatMoney(
              line.sourceTotalMinor,
              line.sourceCurrency,
            )} at ${line.fxRate} (${line.fxSource === "ecb" ? "ECB" : "agreed"} rate)`
          : null,
    })),
    subtotalLabel: formatMoney(invoice.subtotalMinor, invoice.currency),
    taxRowLabel:
      invoice.taxTreatment === "standard"
        ? `VAT (${invoice.taxRatePercent}%)`
        : "VAT",
    taxAmountLabel: formatMoney(invoice.taxMinor, invoice.currency),
    totalLabel: formatMoney(invoice.totalMinor, invoice.currency),
    balanceDueLabel: formatMoneyCode(invoice.totalMinor, invoice.currency),
    balanceCaption: "Balance Due",
    creditsInvoiceLabel: null,
    taxNote: invoice.taxNote,
    notes: invoice.notes,
    paymentLines: [
      ...(business.iban ? [`IBAN ${formatIban(business.iban)}`] : []),
      ...(business.bic ? [`BIC ${business.bic}`] : []),
    ],
  };
}

type BusinessParty = Parameters<typeof buildInvoicePdfData>[0]["business"];
type ClientParty = Parameters<typeof buildInvoicePdfData>[0]["client"];

// A credit note (#5042) lays out like an invoice: same parties, lines and
// tax rows, titled "Credit note CN-...", with the credited invoice named,
// the reason as its note, and no due date or payment details (nothing is
// owed on a credit note).
export function buildCreditNotePdfData(input: {
  creditNote: {
    number: string;
    currency: string;
    issueDate: Date;
    taxTreatment: "standard" | "zero_rated" | "reverse_charge";
    taxRatePercent: string;
    taxNote: string | null;
    buyerReference: string | null;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    reason: string | null;
    lines: {
      description: string;
      quantity: string | null;
      unitPriceMinor: number | null;
      totalMinor: number;
    }[];
  };
  invoiceNumber: string | null;
  invoiceIssueDate: Date | null;
  business: BusinessParty;
  client: ClientParty;
}): InvoicePdfData {
  const { creditNote } = input;
  const base = buildInvoicePdfData({
    invoice: {
      number: creditNote.number,
      status: "sent",
      currency: creditNote.currency,
      issueDate: creditNote.issueDate,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      taxTreatment: creditNote.taxTreatment,
      taxRatePercent: creditNote.taxRatePercent,
      taxNote: creditNote.taxNote,
      buyerReference: creditNote.buyerReference,
      subtotalMinor: creditNote.subtotalMinor,
      taxMinor: creditNote.taxMinor,
      totalMinor: creditNote.totalMinor,
      notes: creditNote.reason ? `Reason: ${creditNote.reason}` : null,
      lines: creditNote.lines.map((line) => ({
        ...line,
        sourceCurrency: null,
        sourceTotalMinor: null,
        fxRate: null,
        fxSource: null,
      })),
    },
    business: { ...input.business, iban: null, bic: null },
    client: input.client,
  });
  return {
    ...base,
    title: `Credit note ${creditNote.number}`,
    balanceCaption: "Amount Credited",
    creditsInvoiceLabel: input.invoiceNumber
      ? input.invoiceIssueDate
        ? `${input.invoiceNumber} of ${formatDateFull(input.invoiceIssueDate)}`
        : input.invoiceNumber
      : null,
  };
}
