// Loads an invoice with its parties and turns it into a Peppol BIS 3.0
// UBL e-invoice (#5040), or the CII XML that the invoice PDF embeds as
// Factur-X (#5041). Every caller (the download routes, tRPC, REST, MCP)
// goes through here, so the checks are the same everywhere.

import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";
import { getCreditNote } from "@/modules/billing/credit-notes";
import { getInvoice } from "@/modules/billing/lifecycle";

import { buildCiiInvoice } from "./cii";
import { buildEinvoiceModel, type EinvoiceResult } from "./model";
import { buildUblInvoice } from "./ubl";

export type EinvoiceExport =
  | { ok: true; xml: string; filename: string }
  | { ok: false; missing: string[] };

// The seller and buyer as the e-invoice model reads them.
async function loadParties(db: Db, businessId: string, clientId: string) {
  const [business] = await db
    .select({
      name: schema.business.name,
      einvoicingEnabled: schema.business.einvoicingEnabled,
      postalAddress: schema.business.postalAddress,
      taxConfig: schema.business.taxConfig,
      iban: schema.business.iban,
      bic: schema.business.bic,
      einvoiceContact: schema.business.einvoiceContact,
      peppolId: schema.business.peppolId,
      companyNumber: schema.business.companyNumber,
      companyNumberScheme: schema.business.companyNumberScheme,
    })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  const [client] = await db
    .select({
      name: schema.client.name,
      postalAddress: schema.client.postalAddress,
      vatNumber: schema.client.vatNumber,
      companyNumber: schema.client.companyNumber,
      peppolId: schema.client.peppolId,
    })
    .from(schema.client)
    .where(
      and(
        eq(schema.client.businessId, businessId),
        eq(schema.client.id, clientId),
      ),
    );
  if (!business || !client) {
    return null;
  }
  return {
    business: {
      name: business.name,
      einvoicingEnabled: business.einvoicingEnabled,
      postalAddress: business.postalAddress ?? null,
      vatNumber:
        ((business.taxConfig ?? {}) as { vatNumber?: string }).vatNumber ??
        null,
      iban: business.iban,
      bic: business.bic,
      contact: business.einvoiceContact ?? null,
      peppolId: business.peppolId,
      companyNumber: business.companyNumber,
      companyNumberScheme: business.companyNumberScheme,
    },
    client: {
      name: client.name,
      postalAddress: client.postalAddress ?? null,
      vatNumber: client.vatNumber,
      companyNumber: client.companyNumber,
      peppolId: client.peppolId,
    },
  };
}

async function loadEinvoiceModel(
  db: Db,
  businessId: string,
  invoiceId: string,
): Promise<EinvoiceResult | null> {
  const invoice = await getInvoice(db, businessId, invoiceId);
  if (!invoice) {
    return null;
  }
  const parties = await loadParties(db, businessId, invoice.clientId);
  return parties ? buildEinvoiceModel({ invoice, ...parties }) : null;
}

// A credit note (#5042) as a type 381 document: its own number, date,
// lines and totals, the reason as its note, and the credited invoice (BG-3).
async function loadCreditNoteModel(
  db: Db,
  businessId: string,
  creditNoteId: string,
): Promise<EinvoiceResult | null> {
  const note = await getCreditNote(db, businessId, creditNoteId);
  if (!note) {
    return null;
  }
  const parties = await loadParties(db, businessId, note.clientId);
  if (!parties) {
    return null;
  }
  return buildEinvoiceModel({
    invoice: {
      number: note.number,
      status: "sent",
      currency: note.currency,
      issueDate: note.issueDate,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      taxTreatment: note.taxTreatment,
      taxRatePercent: note.taxRatePercent,
      taxNote: note.taxNote,
      vatexCode: note.vatexCode,
      buyerReference: note.buyerReference,
      subtotalMinor: note.subtotalMinor,
      taxMinor: note.taxMinor,
      totalMinor: note.totalMinor,
      notes: note.reason ? `Reason: ${note.reason}` : null,
      lines: note.lines,
    },
    ...parties,
    creditNote: {
      invoiceNumber: note.invoiceNumber ?? "",
      invoiceIssueDate: note.invoiceIssueDate,
    },
  });
}

// File names from document numbers: a prefix may hold "/" (e.g. "CR/").
export function documentFilename(prefix: string, number: string, ext: string): string {
  return `${prefix}-${number.replace(/[^A-Za-z0-9._-]/g, "-")}.${ext}`;
}

export async function exportCreditNoteEinvoice(
  db: Db,
  businessId: string,
  creditNoteId: string,
): Promise<EinvoiceExport | null> {
  const result = await loadCreditNoteModel(db, businessId, creditNoteId);
  if (!result || !result.ok) {
    return result;
  }
  return {
    ok: true,
    xml: buildUblInvoice(result.model),
    filename: documentFilename("einvoice", result.model.number, "xml"),
  };
}

// The Factur-X (type 381) XML for the credit note PDF, or null: the same
// rule as facturXFor.
export async function facturXForCreditNote(
  db: Db,
  businessId: string,
  creditNoteId: string,
): Promise<string | null> {
  const result = await loadCreditNoteModel(db, businessId, creditNoteId);
  return result?.ok ? buildCiiInvoice(result.model) : null;
}

export async function exportEinvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
): Promise<EinvoiceExport | null> {
  const result = await loadEinvoiceModel(db, businessId, invoiceId);
  if (!result || !result.ok) {
    return result;
  }
  return {
    ok: true,
    xml: buildUblInvoice(result.model),
    filename: `einvoice-${result.model.number}.xml`,
  };
}

// The Factur-X XML for the invoice PDF, or null when the invoice isn't an
// exportable e-invoice (e-invoicing off, a draft or void invoice, missing
// fields): that PDF is then a plain PDF/A-3b, as before. The checks are
// the XML export's, so a PDF carries Factur-X exactly when the XML
// download works.
export async function facturXFor(
  db: Db,
  businessId: string,
  invoiceId: string,
): Promise<string | null> {
  const result = await loadEinvoiceModel(db, businessId, invoiceId);
  return result?.ok ? buildCiiInvoice(result.model) : null;
}
