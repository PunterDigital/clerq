// EN 16931 model -> UN/CEFACT Cross Industry Invoice (CII D16B), the XML
// that Factur-X / ZUGFeRD embed in the invoice PDF (#5041). EN 16931
// profile: GuidelineSpecifiedDocumentContextParameter urn:cen.eu:en16931:2017.
// Same model as ubl.ts, so both exports always say the same thing. Elements
// follow the CII schema's sequence order; empty elements are never written.

import type { EinvoiceModel, EinvoiceParty } from "./model";

export const FACTURX_EN16931_GUIDELINE = "urn:cen.eu:en16931:2017";

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

// CII dates are yyyymmdd with format code 102.
function date(tag: string, iso: string): string {
  return `<${tag}><udt:DateTimeString format="102">${iso.replace(/-/g, "")}</udt:DateTimeString></${tag}>`;
}

function money(minor: number, model: EinvoiceModel): string {
  return (minor / 10 ** model.digits).toFixed(model.digits);
}

function amount(tag: string, minor: number, model: EinvoiceModel, withCurrency = false): string {
  const attrs = withCurrency ? ` currencyID="${esc(model.currency)}"` : "";
  return `<${tag}${attrs}>${money(minor, model)}</${tag}>`;
}

function party(tag: "ram:SellerTradeParty" | "ram:BuyerTradeParty", p: EinvoiceParty): string {
  const [one, two, three] = p.address.lines;
  return (
    `<${tag}>` +
    el("ram:Name", p.name) +
    (p.companyId
      ? `<ram:SpecifiedLegalOrganization>${el("ram:ID", p.companyId)}</ram:SpecifiedLegalOrganization>`
      : "") +
    (p.contact
      ? "<ram:DefinedTradeContact>" +
        el("ram:PersonName", p.contact.name) +
        (p.contact.phone
          ? `<ram:TelephoneUniversalCommunication>${el("ram:CompleteNumber", p.contact.phone)}</ram:TelephoneUniversalCommunication>`
          : "") +
        (p.contact.email
          ? `<ram:EmailURIUniversalCommunication>${el("ram:URIID", p.contact.email)}</ram:EmailURIUniversalCommunication>`
          : "") +
        "</ram:DefinedTradeContact>"
      : "") +
    "<ram:PostalTradeAddress>" +
    el("ram:PostcodeCode", p.address.postcode) +
    el("ram:LineOne", one) +
    el("ram:LineTwo", two) +
    el("ram:LineThree", three) +
    el("ram:CityName", p.address.city) +
    el("ram:CountryID", p.address.country) +
    el("ram:CountrySubDivisionName", p.address.region) +
    "</ram:PostalTradeAddress>" +
    `<ram:URIUniversalCommunication>${el("ram:URIID", p.endpoint.id, ` schemeID="${esc(p.endpoint.scheme)}"`)}</ram:URIUniversalCommunication>` +
    (p.vatId
      ? `<ram:SpecifiedTaxRegistration>${el("ram:ID", p.vatId, ' schemeID="VA"')}</ram:SpecifiedTaxRegistration>`
      : "") +
    `</${tag}>`
  );
}

// Line-level tax: category and rate only (no amounts, no exemption).
function lineTax(model: EinvoiceModel): string {
  const { vat } = model;
  return (
    "<ram:ApplicableTradeTax>" +
    el("ram:TypeCode", "VAT") +
    el("ram:CategoryCode", vat.category) +
    // Category O (not subject to VAT) carries no rate (BR-O-05).
    (vat.category === "O" ? "" : el("ram:RateApplicablePercent", vat.percent)) +
    "</ram:ApplicableTradeTax>"
  );
}

export function buildCiiInvoice(model: EinvoiceModel): string {
  const t = model.totals;
  const { vat } = model;

  const lines = model.lines
    .map(
      (line) =>
        "<ram:IncludedSupplyChainTradeLineItem>" +
        `<ram:AssociatedDocumentLineDocument>${el("ram:LineID", line.id)}</ram:AssociatedDocumentLineDocument>` +
        "<ram:SpecifiedTradeProduct>" +
        el("ram:Name", line.name) +
        el("ram:Description", line.description) +
        "</ram:SpecifiedTradeProduct>" +
        "<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice>" +
        el("ram:ChargeAmount", line.price) +
        "</ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>" +
        "<ram:SpecifiedLineTradeDelivery>" +
        el("ram:BilledQuantity", line.quantity, ` unitCode="${esc(line.unitCode)}"`) +
        "</ram:SpecifiedLineTradeDelivery>" +
        "<ram:SpecifiedLineTradeSettlement>" +
        lineTax(model) +
        "<ram:SpecifiedTradeSettlementLineMonetarySummation>" +
        amount("ram:LineTotalAmount", line.netMinor, model) +
        "</ram:SpecifiedTradeSettlementLineMonetarySummation>" +
        "</ram:SpecifiedLineTradeSettlement>" +
        "</ram:IncludedSupplyChainTradeLineItem>",
    )
    .join("");

  // Intra-community supply needs where and when it was delivered
  // (BR-IC-11 / BR-IC-12): the invoicing period, or the issue date.
  const delivery =
    "<ram:ApplicableHeaderTradeDelivery>" +
    (vat.category === "K"
      ? `<ram:ShipToTradeParty><ram:PostalTradeAddress>${el("ram:CountryID", model.buyer.address.country)}</ram:PostalTradeAddress></ram:ShipToTradeParty>` +
        (model.period
          ? ""
          : `<ram:ActualDeliverySupplyChainEvent>${date("ram:OccurrenceDateTime", model.issueDate)}</ram:ActualDeliverySupplyChainEvent>`)
      : "") +
    "</ram:ApplicableHeaderTradeDelivery>";

  const payment = model.payment
    ? "<ram:SpecifiedTradeSettlementPaymentMeans>" +
      el("ram:TypeCode", "58") +
      `<ram:PayeePartyCreditorFinancialAccount>${el("ram:IBANID", model.payment.iban)}</ram:PayeePartyCreditorFinancialAccount>` +
      (model.payment.bic
        ? `<ram:PayeeSpecifiedCreditorFinancialInstitution>${el("ram:BICID", model.payment.bic)}</ram:PayeeSpecifiedCreditorFinancialInstitution>`
        : "") +
      "</ram:SpecifiedTradeSettlementPaymentMeans>"
    : "";

  const headerTax =
    "<ram:ApplicableTradeTax>" +
    amount("ram:CalculatedAmount", t.taxMinor, model) +
    el("ram:TypeCode", "VAT") +
    el("ram:ExemptionReason", vat.exemptionReason) +
    amount("ram:BasisAmount", t.taxExclusiveMinor, model) +
    el("ram:CategoryCode", vat.category) +
    el("ram:ExemptionReasonCode", vat.exemptionCode) +
    (vat.category === "O" ? "" : el("ram:RateApplicablePercent", vat.percent)) +
    "</ram:ApplicableTradeTax>";

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
    ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
    ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"' +
    ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">' +
    "<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter>" +
    el("ram:ID", FACTURX_EN16931_GUIDELINE) +
    "</ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>" +
    "<rsm:ExchangedDocument>" +
    el("ram:ID", model.number) +
    el("ram:TypeCode", "380") +
    date("ram:IssueDateTime", model.issueDate) +
    (model.note ? `<ram:IncludedNote>${el("ram:Content", model.note)}</ram:IncludedNote>` : "") +
    "</rsm:ExchangedDocument>" +
    "<rsm:SupplyChainTradeTransaction>" +
    lines +
    "<ram:ApplicableHeaderTradeAgreement>" +
    el("ram:BuyerReference", model.buyerReference) +
    party("ram:SellerTradeParty", model.seller) +
    party("ram:BuyerTradeParty", model.buyer) +
    "</ram:ApplicableHeaderTradeAgreement>" +
    delivery +
    "<ram:ApplicableHeaderTradeSettlement>" +
    el("ram:PaymentReference", model.number) +
    el("ram:InvoiceCurrencyCode", model.currency) +
    payment +
    headerTax +
    (model.period
      ? "<ram:BillingSpecifiedPeriod>" +
        date("ram:StartDateTime", model.period.start) +
        date("ram:EndDateTime", model.period.end) +
        "</ram:BillingSpecifiedPeriod>"
      : "") +
    (model.dueDate
      ? `<ram:SpecifiedTradePaymentTerms>${date("ram:DueDateDateTime", model.dueDate)}</ram:SpecifiedTradePaymentTerms>`
      : "") +
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
    amount("ram:LineTotalAmount", t.lineExtensionMinor, model) +
    amount("ram:TaxBasisTotalAmount", t.taxExclusiveMinor, model) +
    // BT-110: CII states the VAT total's currency on the amount itself.
    amount("ram:TaxTotalAmount", t.taxMinor, model, true) +
    amount("ram:GrandTotalAmount", t.taxInclusiveMinor, model) +
    amount("ram:DuePayableAmount", t.payableMinor, model) +
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
    "</ram:ApplicableHeaderTradeSettlement>" +
    "</rsm:SupplyChainTradeTransaction>" +
    "</rsm:CrossIndustryInvoice>\n"
  );
}
