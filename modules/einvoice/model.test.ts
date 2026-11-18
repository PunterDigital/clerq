import { describe, expect, it } from "vitest";

import { EINVOICE_FIXTURES } from "./fixtures";
import { buildEinvoiceModel, type EinvoiceSource } from "./model";
import { endpointFromVat, normalizeVatId } from "./peppol-ids";
import { buildUblInvoice, PEPPOL_BIS3_CUSTOMIZATION_ID } from "./ubl";

function fixture(name: string): EinvoiceSource {
  const found = EINVOICE_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(name);
  return structuredClone(found.source);
}

function model(source: EinvoiceSource) {
  const result = buildEinvoiceModel(source);
  if (!result.ok) throw new Error(result.missing.join("; "));
  return result.model;
}

function missing(source: EinvoiceSource): string[] {
  const result = buildEinvoiceModel(source);
  if (result.ok) throw new Error("expected missing fields");
  return result.missing;
}

describe("e-invoice model (#5040)", () => {
  it("builds every fixture, with totals equal to the invoice's to the cent", () => {
    for (const { name, source } of EINVOICE_FIXTURES) {
      const m = model(structuredClone(source));
      expect(m.totals.lineExtensionMinor, name).toBe(source.invoice.subtotalMinor);
      expect(m.totals.taxMinor, name).toBe(source.invoice.taxMinor);
      expect(m.totals.payableMinor, name).toBe(source.invoice.totalMinor);
      // BR-CO-10: the line amounts add up to the line total.
      expect(m.lines.reduce((sum, l) => sum + l.netMinor, 0), name).toBe(
        source.invoice.subtotalMinor,
      );
      // PEPPOL-EN16931-R120: quantity x price rounds to each line's amount.
      for (const line of m.lines) {
        expect(
          Math.round(Number(line.quantity) * Number(line.price) * 100),
          `${name} line ${line.id}`,
        ).toBe(line.netMinor);
      }
    }
  });

  it("keeps Clerq's rate where it multiplies out, and derives one where it doesn't (FX lines)", () => {
    const m = model(fixture("reverse-charge-fractional-hours"));
    expect(m.lines[0]).toMatchObject({ quantity: "4.083333", unitCode: "HUR", price: "80.00" });
    // 43.75 h converted from GBP: EUR 80/h doesn't give 4062.87.
    expect(m.lines[1].quantity).toBe("43.750000");
    expect(Math.round(43.75 * Number(m.lines[1].price) * 100)).toBe(406287);
  });

  it("writes fixed lines as one unit of their code at the line total", () => {
    const m = model(fixture("zero-rated"));
    expect(m.lines[0]).toMatchObject({ quantity: "1", unitCode: "DAY", price: "1200.00" });
  });

  it("picks the VAT category from the treatment and the VATEX code", () => {
    expect(model(fixture("standard-rate")).vat).toMatchObject({
      category: "S",
      percent: "19",
      exemptionCode: null,
    });
    expect(model(fixture("zero-rated")).vat).toMatchObject({
      category: "Z",
      percent: "0",
      exemptionCode: null,
      exemptionReason: null,
    });
    expect(model(fixture("reverse-charge-fractional-hours")).vat).toMatchObject({
      category: "AE",
      exemptionCode: "VATEX-EU-AE",
    });
    const noCode = fixture("reverse-charge-fractional-hours");
    noCode.invoice.vatexCode = null;
    expect(model(noCode).vat.exemptionCode).toBe("VATEX-EU-AE");
    expect(model(fixture("intra-community")).vat.category).toBe("K");
  });

  it("splits a three-line street into street, additional street and one address line", () => {
    const m = model(fixture("reverse-charge-fractional-hours"));
    expect(m.buyer.address.lines).toEqual(["Keizersgracht 100", "Unit 4", "Back office"]);
    expect(m.buyer.vatId).toBe("NL8123.45.678.B01".replace(/\./g, ""));
    expect(m.buyer.endpoint).toEqual({ scheme: "9944", id: "NL812345678B01" });
  });

  it("lists what's missing instead of building a broken file", () => {
    const draft = fixture("standard-rate");
    draft.invoice.status = "draft";
    draft.invoice.number = null;
    expect(missing(draft)).toContain("Issue the invoice first: drafts can't be exported");

    const off = fixture("standard-rate");
    off.business.einvoicingEnabled = false;
    expect(missing(off)).toContain("Turn on e-invoicing in Settings -> E-invoicing");

    const bare = fixture("reverse-charge-fractional-hours");
    bare.client.postalAddress = null;
    bare.client.vatNumber = null;
    bare.invoice.buyerReference = "  ";
    expect(missing(bare)).toEqual([
      "Lumen Labs B.V.'s address in parts, with a country (the client's page)",
      "Lumen Labs B.V.'s VAT number (needed for reverse charge)",
      "Lumen Labs B.V.'s VAT number (Peppol addresses the buyer by it)",
      "A buyer reference / PO number on the invoice (Peppol requires one)",
    ]);
  });

  it("applies the German domestic rules: IBAN and a full seller contact", () => {
    const de = fixture("standard-rate");
    de.business.iban = null;
    de.business.contact = { name: "Anna Nord", phone: null, email: "a@example.com" };
    expect(missing(de)).toEqual([
      "Your IBAN (Settings -> E-invoicing): German invoices to German buyers need payment instructions",
      "A contact name, phone number and email for your business (Settings -> E-invoicing): German invoices to German buyers need them",
    ]);
    // A German seller billing abroad needs neither.
    const abroad = fixture("zero-rated");
    abroad.business.contact = null;
    expect(buildEinvoiceModel(abroad).ok).toBe(true);
  });

  it("says when it can't work out a Peppol ID or a Dutch KVK number", () => {
    const danish = fixture("intra-community");
    danish.client.postalAddress = { ...danish.client.postalAddress!, country: "DK" };
    danish.client.vatNumber = "DK12345678";
    expect(missing(danish)).toEqual([
      "A Peppol ID for Lumen Labs B.V.: Clerq can't work one out from a VAT number in DK yet",
    ]);

    const dutchSeller = fixture("zero-rated");
    dutchSeller.business.postalAddress = {
      street: "Keizersgracht 1",
      city: "Amsterdam",
      postcode: "1015 AA",
      region: null,
      country: "NL",
    };
    dutchSeller.business.vatNumber = "NL123456789B01";
    expect(missing(dutchSeller)).toEqual([
      "A KVK number for your business: Dutch e-invoices need one, and Clerq can't add it to the export yet",
    ]);
  });
});

describe("Peppol IDs from VAT numbers", () => {
  it("adds the country prefix, strips punctuation and uses EL for Greece", () => {
    expect(normalizeVatId("123 456 789", "DE")).toBe("DE123456789");
    expect(normalizeVatId("be 0123.456.789", "BE")).toBe("BE0123456789");
    expect(normalizeVatId("094014201", "GR")).toBe("EL094014201");
    expect(normalizeVatId("GR094014201", "GR")).toBe("EL094014201");
  });

  it("maps VAT numbers to the country's EAS scheme, or nothing", () => {
    expect(endpointFromVat("DE123456789", "DE")).toEqual({ scheme: "9930", id: "DE123456789" });
    expect(endpointFromVat("01234567890", "IT")).toEqual({ scheme: "0211", id: "IT01234567890" });
    expect(endpointFromVat("SE556677889901", "SE")).toBeNull();
    expect(endpointFromVat(null, "DE")).toBeNull();
  });
});

describe("UBL writer", () => {
  it("writes a Peppol BIS 3.0 invoice with no empty elements and escaped text", () => {
    const source = fixture("standard-rate");
    source.client.name = "Müller & Söhne <GmbH>";
    const xml = buildUblInvoice(model(source));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<cbc:CustomizationID>${PEPPOL_BIS3_CUSTOMIZATION_ID}</cbc:CustomizationID>`);
    expect(xml).toContain("<cbc:RegistrationName>Müller &amp; Söhne &lt;GmbH&gt;</cbc:RegistrationName>");
    expect(xml).not.toMatch(/<(c[ab]c:\w+)[^>]*>\s*<\/\1>/);
    expect(xml).toContain('<cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>');
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="HUR">11.250000</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">180.03</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">1127.53</cbc:PayableAmount>');
    expect(xml).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>");
    expect(xml).toContain("<cbc:Telephone>+49 30 1234567</cbc:Telephone>");
  });

  it("leaves payment means out without an IBAN, and adds the delivery country for K", () => {
    expect(buildUblInvoice(model(fixture("zero-rated")))).not.toContain("PaymentMeans");
    const k = buildUblInvoice(model(fixture("intra-community")));
    expect(k).toContain(
      "<cac:Delivery><cbc:ActualDeliveryDate>2026-06-11</cbc:ActualDeliveryDate><cac:DeliveryLocation><cac:Address><cac:Country><cbc:IdentificationCode>NL</cbc:IdentificationCode>",
    );
  });

  it("formats amounts in the currency's minor units (JPY has none)", () => {
    const yen = fixture("zero-rated");
    yen.invoice.currency = "JPY";
    yen.invoice.subtotalMinor = 120000;
    yen.invoice.totalMinor = 120000;
    yen.invoice.lines[0].totalMinor = 120000;
    const xml = buildUblInvoice(model(yen));
    expect(xml).toContain('<cbc:PayableAmount currencyID="JPY">120000</cbc:PayableAmount>');
  });
});

describe("credit notes as e-invoices (#5042)", () => {
  it("writes a UBL CreditNote that references the credited invoice", () => {
    const m = model(fixture("credit-note"));
    expect(m.typeCode).toBe("381");
    expect(m.precedingInvoice).toEqual({ number: "2026-0001", issueDate: "2026-06-11" });
    // Nothing is due on a credit note; the payment means stay (DE-R-001).
    expect(m.dueDate).toBeNull();
    expect(m.payment).toMatchObject({ iban: "DE89370400440532013000" });
    const xml = buildUblInvoice(m);
    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain(
      "<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>2026-0001</cbc:ID><cbc:IssueDate>2026-06-11</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>",
    );
    expect(xml).toContain('<cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">297.50</cbc:PayableAmount>');
    expect(xml).not.toContain("InvoiceLine");
    expect(xml).not.toContain("DueDate");
    expect(xml.trim().endsWith("</CreditNote>")).toBe(true);
  });

  it("asks a German credit note for an IBAN too (DE-R-001)", () => {
    const source = fixture("credit-note");
    source.business.iban = null;
    expect(missing(source).join(" ")).toMatch(/IBAN/);
  });

  it("keeps invoices as type 380 with no billing reference", () => {
    const xml = buildUblInvoice(model(fixture("standard-rate")));
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).not.toContain("BillingReference");
    expect(xml.trim().endsWith("</Invoice>")).toBe(true);
  });
});
