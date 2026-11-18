// Loads an invoice with its parties and turns it into a Peppol BIS 3.0
// UBL e-invoice (#5040). Every caller (the download route, tRPC, REST,
// MCP) goes through here, so the checks are the same everywhere.

import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";
import { getInvoice } from "@/modules/billing/lifecycle";

import { buildEinvoiceModel } from "./model";
import { buildUblInvoice } from "./ubl";

export type EinvoiceExport =
  | { ok: true; xml: string; filename: string }
  | { ok: false; missing: string[] };

export async function exportEinvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
): Promise<EinvoiceExport | null> {
  const invoice = await getInvoice(db, businessId, invoiceId);
  if (!invoice) {
    return null;
  }
  const [business] = await db
    .select({
      name: schema.business.name,
      einvoicingEnabled: schema.business.einvoicingEnabled,
      postalAddress: schema.business.postalAddress,
      taxConfig: schema.business.taxConfig,
      iban: schema.business.iban,
      bic: schema.business.bic,
      einvoiceContact: schema.business.einvoiceContact,
    })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  const [client] = await db
    .select({
      name: schema.client.name,
      postalAddress: schema.client.postalAddress,
      vatNumber: schema.client.vatNumber,
      companyNumber: schema.client.companyNumber,
    })
    .from(schema.client)
    .where(
      and(
        eq(schema.client.businessId, businessId),
        eq(schema.client.id, invoice.clientId),
      ),
    );
  if (!business || !client) {
    return null;
  }

  const result = buildEinvoiceModel({
    invoice,
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
    },
    client: {
      name: client.name,
      postalAddress: client.postalAddress ?? null,
      vatNumber: client.vatNumber,
      companyNumber: client.companyNumber,
    },
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    xml: buildUblInvoice(result.model),
    filename: `einvoice-${result.model.number}.xml`,
  };
}
