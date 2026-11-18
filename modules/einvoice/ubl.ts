// EN 16931 model -> UBL 2.1 Invoice, Peppol BIS Billing 3.0 flavour.
// Plain string building in the UBL schema's element order; empty elements
// are never written (PEPPOL-EN16931-R008).

import type { EinvoiceModel, EinvoiceParty } from "./model";

export const PEPPOL_BIS3_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_BIS3_PROFILE_ID =
  "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// <tag attrs>value</tag>, or nothing when the value is empty.
function el(tag: string, value: string | null | undefined, attrs = ""): string {
  if (value == null || value.trim() === "") {
    return "";
  }
  return `<${tag}${attrs}>${esc(value)}</${tag}>`;
}

function amount(tag: string, minor: number, model: EinvoiceModel): string {
  const major = (minor / 10 ** model.digits).toFixed(model.digits);
  return `<${tag} currencyID="${esc(model.currency)}">${major}</${tag}>`;
}

function taxCategory(
  tag: "cac:TaxCategory" | "cac:ClassifiedTaxCategory",
  model: EinvoiceModel,
  withExemption: boolean,
): string {
  const { vat } = model;
  return (
    `<${tag}>` +
    el("cbc:ID", vat.category) +
    // Category O (not subject to VAT) carries no rate (BR-O-05/BR-O-14).
    (vat.category === "O" ? "" : el("cbc:Percent", vat.percent)) +
    (withExemption
      ? el("cbc:TaxExemptionReasonCode", vat.exemptionCode) +
        el("cbc:TaxExemptionReason", vat.exemptionReason)
      : "") +
    "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>" +
    `</${tag}>`
  );
}

function party(
  wrapper: "cac:AccountingSupplierParty" | "cac:AccountingCustomerParty",
  p: EinvoiceParty,
): string {
  const [street, additional, line] = p.address.lines;
  return (
    `<${wrapper}><cac:Party>` +
    el("cbc:EndpointID", p.endpoint.id, ` schemeID="${esc(p.endpoint.scheme)}"`) +
    "<cac:PostalAddress>" +
    el("cbc:StreetName", street) +
    el("cbc:AdditionalStreetName", additional) +
    el("cbc:CityName", p.address.city) +
    el("cbc:PostalZone", p.address.postcode) +
    el("cbc:CountrySubentity", p.address.region) +
    (line ? `<cac:AddressLine>${el("cbc:Line", line)}</cac:AddressLine>` : "") +
    `<cac:Country>${el("cbc:IdentificationCode", p.address.country)}</cac:Country>` +
    "</cac:PostalAddress>" +
    (p.vatId
      ? `<cac:PartyTaxScheme>${el("cbc:CompanyID", p.vatId)}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
      : "") +
    `<cac:PartyLegalEntity>${el("cbc:RegistrationName", p.name)}${el("cbc:CompanyID", p.companyId, p.companyIdScheme ? ` schemeID="${esc(p.companyIdScheme)}"` : "")}</cac:PartyLegalEntity>` +
    (p.contact
      ? "<cac:Contact>" +
        el("cbc:Name", p.contact.name) +
        el("cbc:Telephone", p.contact.phone) +
        el("cbc:ElectronicMail", p.contact.email) +
        "</cac:Contact>"
      : "") +
    `</cac:Party></${wrapper}>`
  );
}

// Writes a UBL Invoice, or a UBL CreditNote for type 381 (#5042): same
// content, with the CreditNote root, type code and line elements, and a
// BillingReference to the credited invoice (BG-3).
export function buildUblInvoice(model: EinvoiceModel): string {
  const t = model.totals;
  const credit = model.typeCode === "381";
  const root = credit ? "CreditNote" : "Invoice";
  const lineTag = credit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  const quantityTag = credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";
  // Intra-community supply needs where and when it was delivered
  // (BR-IC-11 / BR-IC-12): the invoicing period, or the issue date.
  const delivery =
    model.vat.category === "K"
      ? "<cac:Delivery>" +
        (model.period ? "" : el("cbc:ActualDeliveryDate", model.issueDate)) +
        `<cac:DeliveryLocation><cac:Address><cac:Country>${el("cbc:IdentificationCode", model.buyer.address.country)}</cac:Country></cac:Address></cac:DeliveryLocation>` +
        "</cac:Delivery>"
      : "";
  const payment = model.payment
    ? "<cac:PaymentMeans>" +
      el("cbc:PaymentMeansCode", "58") +
      el("cbc:PaymentID", model.number) +
      "<cac:PayeeFinancialAccount>" +
      el("cbc:ID", model.payment.iban) +
      (model.payment.bic
        ? `<cac:FinancialInstitutionBranch>${el("cbc:ID", model.payment.bic)}</cac:FinancialInstitutionBranch>`
        : "") +
      "</cac:PayeeFinancialAccount>" +
      "</cac:PaymentMeans>"
    : "";

  const lines = model.lines
    .map(
      (line) =>
        `<${lineTag}>` +
        el("cbc:ID", line.id) +
        el(quantityTag, line.quantity, ` unitCode="${esc(line.unitCode)}"`) +
        amount("cbc:LineExtensionAmount", line.netMinor, model) +
        "<cac:Item>" +
        el("cbc:Description", line.description) +
        el("cbc:Name", line.name) +
        taxCategory("cac:ClassifiedTaxCategory", model, false) +
        "</cac:Item>" +
        `<cac:Price><cbc:PriceAmount currencyID="${esc(model.currency)}">${line.price}</cbc:PriceAmount></cac:Price>` +
        `</${lineTag}>`,
    )
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"` +
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">' +
    el("cbc:CustomizationID", PEPPOL_BIS3_CUSTOMIZATION_ID) +
    el("cbc:ProfileID", PEPPOL_BIS3_PROFILE_ID) +
    el("cbc:ID", model.number) +
    el("cbc:IssueDate", model.issueDate) +
    // UBL 2.1's CreditNote has no DueDate (and a credit note has none).
    (credit ? "" : el("cbc:DueDate", model.dueDate)) +
    el(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", model.typeCode) +
    el("cbc:Note", model.note) +
    el("cbc:DocumentCurrencyCode", model.currency) +
    el("cbc:BuyerReference", model.buyerReference) +
    (model.period
      ? `<cac:InvoicePeriod>${el("cbc:StartDate", model.period.start)}${el("cbc:EndDate", model.period.end)}</cac:InvoicePeriod>`
      : "") +
    (model.precedingInvoice
      ? "<cac:BillingReference><cac:InvoiceDocumentReference>" +
        el("cbc:ID", model.precedingInvoice.number) +
        el("cbc:IssueDate", model.precedingInvoice.issueDate) +
        "</cac:InvoiceDocumentReference></cac:BillingReference>"
      : "") +
    party("cac:AccountingSupplierParty", model.seller) +
    party("cac:AccountingCustomerParty", model.buyer) +
    delivery +
    payment +
    "<cac:TaxTotal>" +
    amount("cbc:TaxAmount", t.taxMinor, model) +
    "<cac:TaxSubtotal>" +
    amount("cbc:TaxableAmount", t.taxExclusiveMinor, model) +
    amount("cbc:TaxAmount", t.taxMinor, model) +
    taxCategory("cac:TaxCategory", model, true) +
    "</cac:TaxSubtotal>" +
    "</cac:TaxTotal>" +
    "<cac:LegalMonetaryTotal>" +
    amount("cbc:LineExtensionAmount", t.lineExtensionMinor, model) +
    amount("cbc:TaxExclusiveAmount", t.taxExclusiveMinor, model) +
    amount("cbc:TaxInclusiveAmount", t.taxInclusiveMinor, model) +
    amount("cbc:PayableAmount", t.payableMinor, model) +
    "</cac:LegalMonetaryTotal>" +
    lines +
    `</${root}>\n`
  );
}
