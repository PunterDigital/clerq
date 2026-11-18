import { describe, expect, it } from "vitest";

import { buildCiiInvoice, FACTURX_EN16931_GUIDELINE } from "./cii";
import { EINVOICE_FIXTURES } from "./fixtures";
import { buildEinvoiceModel, type EinvoiceSource } from "./model";

function fixture(name: string): EinvoiceSource {
  const found = EINVOICE_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(name);
  return structuredClone(found.source);
}

function cii(source: EinvoiceSource): string {
  const result = buildEinvoiceModel(source);
  if (!result.ok) throw new Error(result.missing.join("; "));
  return buildCiiInvoice(result.model);
}

// The full validation (Factur-X XSD + EN 16931 Schematron, veraPDF) runs in
// CI over the fixture PDFs: scripts/validate-facturx.sh. These pin the
// mapping's choices.
describe("CII writer (#5041)", () => {
  it("writes the EN 16931 profile with dates, totals and escaped text", () => {
    const source = fixture("standard-rate");
    source.business.name = "Nord & Söhne <GmbH>";
    const xml = cii(source);
    expect(xml).toContain(`<ram:ID>${FACTURX_EN16931_GUIDELINE}</ram:ID>`);
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toMatch(/<ram:IssueDateTime><udt:DateTimeString format="102">\d{8}<\/udt:DateTimeString>/);
    expect(xml).toContain("<ram:Name>Nord &amp; Söhne &lt;GmbH&gt;</ram:Name>");
    expect(xml).toContain('<ram:ID schemeID="VA">DE123456789</ram:ID>');
    expect(xml).toContain("<ram:IBANID>DE89370400440532013000</ram:IBANID>");
    expect(xml).toMatch(/<ram:TaxTotalAmount currencyID="EUR">[\d.]+<\/ram:TaxTotalAmount>/);
    // Empty elements are never written (one required container aside).
    const empty = xml.match(/<(ram:[A-Za-z]+)[^>]*><\/\1>/g) ?? [];
    expect(empty).toEqual(["<ram:ApplicableHeaderTradeDelivery></ram:ApplicableHeaderTradeDelivery>"]);
  });

  it("states the reverse charge with its exemption code and a zero rate", () => {
    const xml = cii(fixture("reverse-charge-fractional-hours"));
    expect(xml).toContain("<ram:CategoryCode>AE</ram:CategoryCode>");
    expect(xml).toContain("<ram:ExemptionReasonCode>VATEX-EU-AE</ram:ExemptionReasonCode>");
    expect(xml).toContain("<ram:RateApplicablePercent>0</ram:RateApplicablePercent>");
    expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">4.083333</ram:BilledQuantity>');
  });

  it("adds the deliver-to country for intra-community supply (BR-IC-12)", () => {
    const xml = cii(fixture("intra-community"));
    expect(xml).toContain("<ram:CategoryCode>K</ram:CategoryCode>");
    expect(xml).toContain(
      "<ram:ShipToTradeParty><ram:PostalTradeAddress><ram:CountryID>NL</ram:CountryID></ram:PostalTradeAddress></ram:ShipToTradeParty>",
    );
  });

  it("leaves payment means out without an IBAN", () => {
    expect(cii(fixture("zero-rated"))).not.toContain("SpecifiedTradeSettlementPaymentMeans");
  });
});

describe("CII credit notes (#5042)", () => {
  it("writes type 381 with the credited invoice after the totals", () => {
    const xml = cii(fixture("credit-note"));
    expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>");
    expect(xml).toContain(
      '</ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:InvoiceReferencedDocument><ram:IssuerAssignedID>2026-0001</ram:IssuerAssignedID><ram:FormattedIssueDateTime><qdt:DateTimeString format="102">20260611</qdt:DateTimeString></ram:FormattedIssueDateTime></ram:InvoiceReferencedDocument>',
    );
    expect(xml).not.toContain("DueDateDateTime");
  });

  it("keeps invoices as type 380", () => {
    const xml = cii(fixture("standard-rate"));
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).not.toContain("InvoiceReferencedDocument");
  });
});
