// Clerq invoice -> EN 16931 semantic model (the subset Clerq produces).
// Kept apart from the syntax (ubl.ts) so an EN 16931-1:2026 / Peppol BIS 4.0
// or a CII (Factur-X) writer can sit next to it later. Pure: no database.

import type { PostalAddress } from "@/lib/postal-address";
import { minorUnitDigits } from "@/modules/billing/currency";

import { endpointFromVat, normalizeVatId, type EndpointId } from "./peppol-ids";

export type TaxTreatment = "standard" | "zero_rated" | "reverse_charge";

// What the mapping reads: the invoice row with its lines, and the two
// parties. Field names follow Clerq's schema so callers pass rows as is.
export type EinvoiceSource = {
  invoice: {
    number: string | null;
    status: "draft" | "sent" | "paid" | "overdue" | "void";
    currency: string;
    issueDate: Date | null;
    dueDate: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    taxTreatment: TaxTreatment;
    taxRatePercent: string;
    taxNote: string | null;
    vatexCode: string | null;
    buyerReference: string | null;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    notes: string | null;
    lines: {
      description: string;
      quantity: string | null;
      unitPriceMinor: number | null;
      totalMinor: number;
      unitCode: string;
    }[];
  };
  business: {
    name: string;
    einvoicingEnabled: boolean;
    postalAddress: PostalAddress | null;
    vatNumber: string | null;
    iban: string | null;
    bic: string | null;
    // Seller contact (BG-6): required between two German parties.
    contact: EinvoiceContact | null;
  };
  client: {
    name: string;
    postalAddress: PostalAddress | null;
    vatNumber: string | null;
    companyNumber: string | null;
  };
};

export type EinvoiceContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

// EN 16931 VAT category codes (UNCL5305) Clerq can produce.
export type VatCategory = "S" | "Z" | "AE" | "K" | "G" | "E" | "O";

export type EinvoiceParty = {
  name: string;
  endpoint: EndpointId;
  address: {
    lines: string[]; // up to 3: street, additional street, address line
    city: string | null;
    postcode: string | null;
    region: string | null;
    country: string;
  };
  vatId: string | null;
  companyId: string | null;
  contact: EinvoiceContact | null;
};

export type EinvoiceModel = {
  number: string;
  issueDate: string; // yyyy-mm-dd
  dueDate: string | null;
  currency: string;
  // Decimal places of the currency's amounts in the XML.
  digits: number;
  note: string | null;
  buyerReference: string;
  period: { start: string; end: string } | null;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  payment: { iban: string; bic: string | null } | null;
  vat: {
    category: VatCategory;
    percent: string;
    exemptionCode: string | null;
    exemptionReason: string | null;
  };
  // Amounts in minor units; the writer formats them.
  totals: {
    lineExtensionMinor: number;
    taxMinor: number;
    taxExclusiveMinor: number;
    taxInclusiveMinor: number;
    payableMinor: number;
  };
  lines: {
    id: string;
    name: string;
    description: string | null;
    quantity: string;
    unitCode: string;
    netMinor: number;
    // Net price per unit as a decimal string in major units.
    price: string;
  }[];
};

export type EinvoiceResult =
  | { ok: true; model: EinvoiceModel }
  | { ok: false; missing: string[] };

// VATEX code -> the VAT category it belongs to (EN 16931 BR-AE/K/G/E/O).
const CATEGORY_BY_VATEX: Record<string, VatCategory> = {
  "VATEX-EU-AE": "AE",
  "VATEX-EU-IC": "K",
  "VATEX-EU-G": "G",
  "VATEX-EU-79-C": "E",
  "VATEX-EU-O": "O",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function vatCategory(source: EinvoiceSource["invoice"]): {
  category: VatCategory;
  exemptionCode: string | null;
} {
  if (source.taxTreatment === "standard") {
    return { category: "S", exemptionCode: null };
  }
  if (source.vatexCode && CATEGORY_BY_VATEX[source.vatexCode]) {
    return {
      category: CATEGORY_BY_VATEX[source.vatexCode],
      exemptionCode: source.vatexCode,
    };
  }
  if (source.taxTreatment === "reverse_charge") {
    return { category: "AE", exemptionCode: "VATEX-EU-AE" };
  }
  // Zero-rated goods and services: no exemption reason allowed (BR-Z-10).
  return { category: "Z", exemptionCode: null };
}

// Splits Clerq's street (up to 3 newline-separated lines) into UBL's
// StreetName, AdditionalStreetName and a single AddressLine (UBL-SR-51).
function addressOf(
  postal: PostalAddress,
): EinvoiceParty["address"] {
  const lines = (postal.street ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    lines: [...lines.slice(0, 2), ...(lines.length > 2 ? [lines.slice(2).join(", ")] : [])],
    city: postal.city ?? null,
    postcode: postal.postcode ?? null,
    region: postal.region ?? null,
    country: postal.country,
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? text.trim()
  );
}

// "4.083333" x 6200 minor -> does it multiply out (to the cent) to the line
// net amount, as PEPPOL-EN16931-R120 checks? Otherwise a price is derived
// from the total so it does.
function linePrice(
  quantity: string,
  unitPriceMinor: number | null,
  netMinor: number,
  digits: number,
): string | null {
  const q = Number(quantity);
  if (!(q > 0)) {
    return null;
  }
  const scale = 10 ** digits;
  const multipliesOut = (priceMajor: number) =>
    Math.round(q * priceMajor * scale) === netMinor;
  if (unitPriceMinor !== null && multipliesOut(unitPriceMinor / scale)) {
    return (unitPriceMinor / scale).toFixed(digits);
  }
  for (let places = digits; places <= 6; places++) {
    const candidate = Number((netMinor / scale / q).toFixed(places));
    if (multipliesOut(candidate)) {
      return candidate.toFixed(places);
    }
  }
  return null;
}

function contactOrNull(c: EinvoiceContact | null): EinvoiceContact | null {
  if (!c) return null;
  const clean = {
    name: c.name?.trim() || null,
    phone: c.phone?.trim() || null,
    email: c.email?.trim() || null,
  };
  return clean.name || clean.phone || clean.email ? clean : null;
}

// National rules in Peppol BIS 3.0.22 that need data Clerq may not have,
// checked here so the user gets a list instead of a file a validator
// refuses. Rules the mapping always satisfies aren't repeated.
function nationalRules(
  source: EinvoiceSource,
  sellerCountry: string | null,
  buyerCountry: string | null,
): string[] {
  const { business, client } = source;
  const out: string[] = [];
  const seller = business.postalAddress;
  const buyer = client.postalAddress;
  if (sellerCountry === "DE" && buyerCountry === "DE") {
    // DE-R-001, DE-R-002/005/006/007, DE-R-003/004, DE-R-008/009.
    if (!business.iban) {
      out.push("Your IBAN (Settings -> E-invoicing): German invoices to German buyers need payment instructions");
    }
    const contact = contactOrNull(business.contact);
    if (!contact?.name || !contact.phone || !contact.email) {
      out.push(
        "A contact name, phone number and email for your business (Settings -> E-invoicing): German invoices to German buyers need them",
      );
    }
    if (!seller?.city || !seller.postcode) {
      out.push("The city and postcode of your business address (Settings -> E-invoicing)");
    }
    if (!buyer?.city || !buyer.postcode) {
      out.push(`The city and postcode of ${client.name}'s address (the client's page)`);
    }
  }
  if (sellerCountry === "NL") {
    // NL-R-003: a KVK or OIN number, which Clerq doesn't store yet.
    out.push(
      "A KVK number for your business: Dutch e-invoices need one, and Clerq can't add it to the export yet",
    );
  }
  if (sellerCountry === "IT" && (!seller?.street || !seller.city || !seller.postcode)) {
    // IT-R-002/003/004.
    out.push("The street, city and postcode of your business address (Settings -> E-invoicing)");
  }
  return out;
}

export function buildEinvoiceModel(source: EinvoiceSource): EinvoiceResult {
  const { invoice, business, client } = source;
  const missing: string[] = [];

  if (!business.einvoicingEnabled) {
    missing.push("Turn on e-invoicing in Settings -> E-invoicing");
  }
  if (invoice.status === "draft" || !invoice.number || !invoice.issueDate) {
    missing.push("Issue the invoice first: drafts can't be exported");
  }
  if (invoice.status === "void") {
    missing.push("This invoice is void: export the replacement instead");
  }

  const { category, exemptionCode } = vatCategory(invoice);
  const sellerCountry = business.postalAddress?.country ?? null;
  const buyerCountry = client.postalAddress?.country ?? null;

  if (!business.postalAddress) {
    missing.push("Your business address in parts (Settings -> E-invoicing)");
  }
  if (!client.postalAddress) {
    missing.push(`${client.name}'s address in parts, with a country (the client's page)`);
  }
  // Category O (not subject to VAT) must not carry VAT identifiers (BR-O-02..04).
  const sellerVat =
    category !== "O" && business.vatNumber?.trim() && sellerCountry
      ? normalizeVatId(business.vatNumber, sellerCountry)
      : null;
  const buyerVat =
    category !== "O" && client.vatNumber?.trim() && buyerCountry
      ? normalizeVatId(client.vatNumber, buyerCountry)
      : null;
  if (category !== "O" && !business.vatNumber?.trim()) {
    missing.push("Your VAT number (Settings)");
  }
  if (["AE", "K"].includes(category) && !client.vatNumber?.trim()) {
    missing.push(`${client.name}'s VAT number (needed for ${category === "AE" ? "reverse charge" : "intra-community supply"})`);
  }

  const sellerEndpoint = endpointFromVat(business.vatNumber, sellerCountry);
  if (!sellerEndpoint && sellerCountry) {
    missing.push(
      business.vatNumber?.trim()
        ? `A Peppol ID for your business: Clerq can't work one out from a VAT number in ${sellerCountry} yet`
        : "Your VAT number (Settings)",
    );
  }
  const buyerEndpoint = endpointFromVat(client.vatNumber, buyerCountry);
  if (!buyerEndpoint) {
    missing.push(
      client.vatNumber?.trim() && buyerCountry
        ? `A Peppol ID for ${client.name}: Clerq can't work one out from a VAT number in ${buyerCountry} yet`
        : `${client.name}'s VAT number (Peppol addresses the buyer by it)`,
    );
  }
  if (!invoice.buyerReference?.trim()) {
    missing.push("A buyer reference / PO number on the invoice (Peppol requires one)");
  }
  missing.push(...nationalRules(source, sellerCountry, buyerCountry));

  if (missing.length > 0) {
    return { ok: false, missing: [...new Set(missing)] };
  }

  const digits = minorUnitDigits(invoice.currency);
  const lines: EinvoiceModel["lines"] = [];
  for (const [i, line] of invoice.lines.entries()) {
    const hasQuantity = line.quantity !== null && Number(line.quantity) > 0;
    const price = hasQuantity
      ? linePrice(line.quantity as string, line.unitPriceMinor, line.totalMinor, digits)
      : null;
    const name = firstLine(line.description);
    const description = line.description.trim() !== name ? line.description.trim() : null;
    if (hasQuantity && price !== null) {
      lines.push({
        id: String(i + 1),
        name,
        description,
        quantity: line.quantity as string,
        unitCode: line.unitCode,
        netMinor: line.totalMinor,
        price,
      });
    } else {
      // Fixed amounts: one unit at the line total.
      lines.push({
        id: String(i + 1),
        name,
        description,
        quantity: "1",
        unitCode: line.unitCode,
        netMinor: line.totalMinor,
        price: (line.totalMinor / 10 ** digits).toFixed(digits),
      });
    }
  }

  const party = (
    name: string,
    postal: PostalAddress,
    endpoint: EndpointId,
    vatId: string | null,
    companyId: string | null,
    contact: EinvoiceContact | null,
  ): EinvoiceParty => ({
    name,
    endpoint,
    address: addressOf(postal),
    vatId,
    companyId,
    contact,
  });

  return {
    ok: true,
    model: {
      number: invoice.number as string,
      issueDate: isoDate(invoice.issueDate as Date),
      dueDate: invoice.dueDate ? isoDate(invoice.dueDate) : null,
      currency: invoice.currency,
      digits,
      note: invoice.notes?.trim() || null,
      buyerReference: (invoice.buyerReference as string).trim(),
      period:
        invoice.periodStart && invoice.periodEnd
          ? { start: isoDate(invoice.periodStart), end: isoDate(invoice.periodEnd) }
          : null,
      seller: party(
        business.name,
        business.postalAddress as PostalAddress,
        sellerEndpoint as EndpointId,
        sellerVat,
        null,
        contactOrNull(business.contact),
      ),
      buyer: party(
        client.name,
        client.postalAddress as PostalAddress,
        buyerEndpoint as EndpointId,
        buyerVat,
        client.companyNumber?.trim() || null,
        null,
      ),
      payment: business.iban ? { iban: business.iban, bic: business.bic } : null,
      vat: {
        category,
        percent: category === "S" ? invoice.taxRatePercent : "0",
        exemptionCode,
        exemptionReason: exemptionCode ? invoice.taxNote : null,
      },
      totals: {
        lineExtensionMinor: invoice.subtotalMinor,
        taxMinor: invoice.taxMinor,
        taxExclusiveMinor: invoice.subtotalMinor,
        taxInclusiveMinor: invoice.totalMinor,
        payableMinor: invoice.totalMinor,
      },
      lines,
    },
  };
}
