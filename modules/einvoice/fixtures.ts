// Invoices shaped exactly like Clerq's rows, one per case the export must
// get right. The unit tests read them, and `scripts/einvoice-fixtures.ts`
// writes their XML for the CI job that runs the CEN EN 16931 and Peppol
// BIS 3.0 validators over it (#5040). Clerq has one VAT treatment per
// invoice, so there is no mixed-rate case.

import type { EinvoiceSource } from "./model";

const seller: EinvoiceSource["business"] = {
  name: "Studio Nord GmbH",
  einvoicingEnabled: true,
  postalAddress: {
    street: "Hauptstraße 5\nHinterhaus, 2. OG",
    city: "Berlin",
    postcode: "10115",
    region: null,
    country: "DE",
  },
  vatNumber: "DE123456789",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  contact: { name: "Anna Nord", phone: "+49 30 1234567", email: "billing@studio-nord.example" },
};

const germanBuyer: EinvoiceSource["client"] = {
  name: "Musterhaus AG",
  postalAddress: {
    street: "Marktplatz 1",
    city: "Hamburg",
    postcode: "20095",
    region: null,
    country: "DE",
  },
  vatNumber: "DE987654321",
  companyNumber: "HRB 12345",
};

const dutchBuyer: EinvoiceSource["client"] = {
  name: "Lumen Labs B.V.",
  postalAddress: {
    street: "Keizersgracht 100\nUnit 4\nBack office",
    city: "Amsterdam",
    postcode: "1015 AA",
    region: "Noord-Holland",
    country: "NL",
  },
  vatNumber: "NL 8123.45.678.B01",
  companyNumber: "12345678",
};

const austrianBuyer: EinvoiceSource["client"] = {
  name: "Alpenblick GmbH",
  postalAddress: {
    street: "Ringstraße 12",
    city: "Wien",
    postcode: "1010",
    region: null,
    country: "AT",
  },
  vatNumber: "ATU12345678",
  companyNumber: null,
};

const issued = {
  status: "sent" as const,
  issueDate: new Date("2026-06-11T00:00:00Z"),
  dueDate: new Date("2026-07-11T00:00:00Z"),
  periodStart: null as Date | null,
  periodEnd: null as Date | null,
  notes: null as string | null,
  vatexCode: null as string | null,
  buyerReference: "PO-7781" as string | null,
};

export const EINVOICE_FIXTURES: { name: string; source: EinvoiceSource }[] = [
  {
    // 11.25 h at EUR 62/h plus a fixed fee, 19% on the subtotal (rounded once).
    name: "standard-rate",
    source: {
      business: seller,
      client: germanBuyer,
      invoice: {
        ...issued,
        number: "2026-0001",
        currency: "EUR",
        taxTreatment: "standard",
        taxRatePercent: "19",
        taxNote: null,
        subtotalMinor: 69750 + 25000,
        taxMinor: 18003,
        totalMinor: 94750 + 18003,
        notes: "Thank you for your business.\nPayment within 30 days.",
        periodStart: new Date("2026-05-01T00:00:00Z"),
        periodEnd: new Date("2026-05-31T00:00:00Z"),
        lines: [
          {
            description: "Demo Maker - 62.00 EUR/h (Homepage build)\n- Layout\n- Copy edits",
            quantity: "11.250000",
            unitPriceMinor: 6200,
            totalMinor: 69750,
            unitCode: "HUR",
          },
          {
            description: "Setup fee",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 25000,
            unitCode: "C62",
          },
        ],
      },
    },
  },
  {
    // Fractional hours whose total is rounded once (4.083333 h x 80 = 326.67),
    // and a line converted from GBP whose rate doesn't multiply out in EUR.
    name: "reverse-charge-fractional-hours",
    source: {
      business: seller,
      client: dutchBuyer,
      invoice: {
        ...issued,
        number: "2026-0002",
        currency: "EUR",
        taxTreatment: "reverse_charge",
        taxRatePercent: "0",
        taxNote:
          "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
        vatexCode: "VATEX-EU-AE",
        subtotalMinor: 32667 + 406287,
        taxMinor: 0,
        totalMinor: 32667 + 406287,
        lines: [
          {
            description: "Consulting",
            quantity: "4.083333",
            unitPriceMinor: 8000,
            totalMinor: 32667,
            unitCode: "HUR",
          },
          {
            description: "Data engineering (converted from GBP 3,500.00 at 1.1608)",
            quantity: "43.750000",
            unitPriceMinor: 8000,
            totalMinor: 406287,
            unitCode: "HUR",
          },
        ],
      },
    },
  },
  {
    name: "zero-rated",
    source: {
      // No bank details: no payment means in the XML (fine outside DE-DE).
      business: { ...seller, iban: null, bic: null },
      client: austrianBuyer,
      invoice: {
        ...issued,
        number: "2026-0003",
        currency: "EUR",
        taxTreatment: "zero_rated",
        taxRatePercent: "0",
        taxNote: "Zero-rated for VAT purposes",
        subtotalMinor: 120000,
        taxMinor: 0,
        totalMinor: 120000,
        lines: [
          {
            description: "Workshop (fixed fee)",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 120000,
            unitCode: "DAY",
          },
        ],
      },
    },
  },
  {
    // Intra-community supply picked through the VATEX code on a zero-rated
    // invoice: category K, with the delivery country.
    name: "intra-community",
    source: {
      business: seller,
      client: dutchBuyer,
      invoice: {
        ...issued,
        number: "2026-0004",
        currency: "EUR",
        taxTreatment: "zero_rated",
        taxRatePercent: "0",
        taxNote: "Intra-community supply",
        vatexCode: "VATEX-EU-IC",
        subtotalMinor: 50000,
        taxMinor: 0,
        totalMinor: 50000,
        lines: [
          {
            description: "Licence, June",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 50000,
            unitCode: "MON",
          },
        ],
      },
    },
  },
  {
    // A credit note (#5042, type 381) for the setup fee of 2026-0001: its
    // own number, a reference to the invoice (BG-3) and no due date.
    name: "credit-note",
    source: {
      business: seller,
      client: germanBuyer,
      creditNote: {
        invoiceNumber: "2026-0001",
        invoiceIssueDate: new Date("2026-06-11T00:00:00Z"),
      },
      invoice: {
        ...issued,
        number: "CN-2026-0001",
        issueDate: new Date("2026-06-20T00:00:00Z"),
        dueDate: null,
        currency: "EUR",
        taxTreatment: "standard",
        taxRatePercent: "19",
        taxNote: null,
        subtotalMinor: 25000,
        taxMinor: 4750,
        totalMinor: 29750,
        notes: "Reason: Setup fee waived",
        lines: [
          {
            description: "Setup fee",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 25000,
            unitCode: "C62",
          },
        ],
      },
    },
  },
];
