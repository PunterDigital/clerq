import { describe, expect, it } from "vitest";

import { buildInvoicePdfData } from "./pdf-data";

const baseInvoice = {
  number: "2026-0100" as string | null,
  status: "sent" as const,
  currency: "EUR",
  issueDate: new Date("2026-06-11T12:00:00Z"),
  dueDate: new Date("2026-07-11T00:00:00Z"),
  periodStart: null as Date | null,
  periodEnd: null as Date | null,
  taxTreatment: "standard" as const,
  taxRatePercent: "21",
  taxNote: null as string | null,
  subtotalMinor: 69750,
  taxMinor: 14648,
  totalMinor: 84398,
  notes: null as string | null,
  lines: [
    {
      description: "Demo Maker - 62.00 EUR/h",
      quantity: "11.250000" as string | null,
      unitPriceMinor: 6200 as number | null,
      totalMinor: 69750,
      sourceCurrency: null as string | null,
      sourceTotalMinor: null as number | null,
      fxRate: null as string | null,
      fxSource: null as "ecb" | "manual" | null,
    },
  ],
};

const business = {
  name: "Studio Demo",
  address: "12 Harbour Street\nBristol BS1 4QA",
  vatNumber: "GB123456789",
};
const client = {
  name: "Northwind Studio s.r.o.",
  address: "44 Riverside\nPrague 110 00",
  companyNumber: "08123456",
  vatNumber: "CZ12345678",
};

describe("invoice PDF view model", () => {
  it("prints the buyer reference and bank details only when set (#5039)", () => {
    const plain = buildInvoicePdfData({ invoice: baseInvoice, business, client });
    expect(plain.buyerReference).toBeNull();
    expect(plain.paymentLines).toEqual([]);

    const data = buildInvoicePdfData({
      invoice: { ...baseInvoice, buyerReference: "PO-7781" },
      business: { ...business, iban: "DE89370400440532013000", bic: "COBADEFFXXX" },
      client,
    });
    expect(data.buyerReference).toBe("PO-7781");
    expect(data.paymentLines).toEqual([
      "IBAN DE89 3704 0044 0532 0130 00",
      "BIC COBADEFFXXX",
    ]);
  });

  it("labels an issued standard-rate invoice with both VAT numbers", () => {
    const data = buildInvoicePdfData({ invoice: baseInvoice, business, client });
    expect(data.title).toBe("Invoice 2026-0100");
    expect(data.isDraft).toBe(false);
    expect(data.businessVatNumber).toBe("GB123456789");
    expect(data.businessAddressLines).toEqual([
      "12 Harbour Street",
      "Bristol BS1 4QA",
    ]);
    expect(data.clientVatNumber).toBe("CZ12345678");
    expect(data.clientAddressLines).toEqual(["44 Riverside", "Prague 110 00"]);
    expect(data.clientCompanyNumber).toBe("08123456");
    expect(data.issueDateLabel).toBe("11 Jun 2026");
    expect(data.dueDateLabel).toBe("11 Jul 2026");
    expect(data.periodLabel).toBeNull();
    expect(data.lines[0].quantityLabel).toBe("11.25 h x € 62.00/h");
    expect(data.lines[0].totalLabel).toBe("€ 697.50");
    expect(data.taxRowLabel).toBe("VAT (21%)");
    expect(data.taxAmountLabel).toBe("€ 146.48");
    expect(data.totalLabel).toBe("€ 843.98");
    expect(data.balanceDueLabel).toBe("843.98 EUR");
  });

  it("labels drafts as drafts and fixed lines without quantity", () => {
    const data = buildInvoicePdfData({
      invoice: {
        ...baseInvoice,
        number: null,
        status: "draft",
        issueDate: null,
        lines: [
          {
            ...baseInvoice.lines[0],
            description: "Discovery workshop (fixed fee)",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 150000,
          },
        ],
      },
      business,
      client,
    });
    expect(data.title).toBe("Draft invoice");
    expect(data.isDraft).toBe(true);
    expect(data.issueDateLabel).toBeNull();
    expect(data.lines[0].quantityLabel).toBeNull();
    expect(data.lines[0].totalLabel).toBe("€ 1,500.00");
  });

  it("flags a voided invoice while keeping its number and title", () => {
    const data = buildInvoicePdfData({
      invoice: { ...baseInvoice, status: "void" },
      business,
      client,
    });
    expect(data.isVoid).toBe(true);
    expect(data.isPaid).toBe(false);
    expect(data.title).toBe("Invoice 2026-0100");
  });

  it("renders a billing period as a single range label when both dates are set", () => {
    const data = buildInvoicePdfData({
      invoice: {
        ...baseInvoice,
        periodStart: new Date("2026-05-26T00:00:00Z"),
        periodEnd: new Date("2026-06-08T00:00:00Z"),
      },
      business,
      client,
    });
    expect(data.periodLabel).toBe("26 May 2026 - 8 Jun 2026");
  });

  it("defaults to the house teal when the business has no brand colour", () => {
    const data = buildInvoicePdfData({ invoice: baseInvoice, business, client });
    expect(data.brandColor).toBe("#228E80");
    expect(data.logoDataUrl).toBeNull();
    expect(data.footerNote).toBeNull();
  });

  it("carries the business's logo, brand colour and footer note through", () => {
    const data = buildInvoicePdfData({
      invoice: baseInvoice,
      business: {
        ...business,
        brandColor: "#7C3AED",
        logoDataUrl: "data:image/png;base64,AAAA",
        footerNote: "Thank you - payment within 30 days to GB00 BANK 1234.",
      },
      client,
    });
    expect(data.brandColor).toBe("#7C3AED");
    expect(data.logoDataUrl).toBe("data:image/png;base64,AAAA");
    expect(data.footerNote).toBe(
      "Thank you - payment within 30 days to GB00 BANK 1234.",
    );
  });

  it("carries conversion notes and the reverse-charge tax note", () => {
    const data = buildInvoicePdfData({
      invoice: {
        ...baseInvoice,
        taxTreatment: "reverse_charge",
        taxRatePercent: "0",
        taxNote:
          "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
        taxMinor: 0,
        lines: [
          {
            ...baseInvoice.lines[0],
            sourceCurrency: "GBP",
            sourceTotalMinor: 44000,
            fxRate: "1.1597",
            fxSource: "ecb",
          },
        ],
      },
      business,
      client,
    });
    expect(data.lines[0].conversionNote).toBe(
      "Converted from £ 440.00 at 1.1597 (ECB rate)",
    );
    expect(data.taxRowLabel).toBe("VAT");
    expect(data.taxNote).toContain("Article 196");
  });
});
