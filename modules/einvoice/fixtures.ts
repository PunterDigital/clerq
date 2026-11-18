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
  peppolId: null,
  companyNumber: null,
  companyNumberScheme: null,
};

// A Dutch seller (#5075): KVK number as the legal entity ID (NL-R-003),
// full address (NL-R-002) and an IBAN (NL-R-007).
const dutchSeller: EinvoiceSource["business"] = {
  name: "Polder Software B.V.",
  einvoicingEnabled: true,
  postalAddress: {
    street: "Oudegracht 21",
    city: "Utrecht",
    postcode: "3511 AB",
    region: null,
    country: "NL",
  },
  vatNumber: "NL123456789B01",
  iban: "NL91ABNA0417164300",
  bic: "ABNANL2A",
  contact: null,
  peppolId: "0106:87654321",
  companyNumber: "87654321",
  companyNumberScheme: "0106",
};

// A Danish seller: the CVR number is the legal entity ID (DK-R-002,
// DK-R-014) and, with no Peppol ID typed in, the Peppol address too.
const danishSeller: EinvoiceSource["business"] = {
  name: "Havn Digital ApS",
  einvoicingEnabled: true,
  postalAddress: {
    street: "Nyhavn 12",
    city: "København K",
    postcode: "1051",
    region: null,
    country: "DK",
  },
  vatNumber: "DK13585628",
  iban: "DK5000400440116243",
  bic: null,
  contact: null,
  peppolId: null,
  companyNumber: "13 58 56 28",
  companyNumberScheme: "0184",
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
  peppolId: null,
};

// A Danish buyer addressed by its CVR number (EAS 0184), typed in as the
// client's Peppol ID (#5075).
const danishBuyer: EinvoiceSource["client"] = {
  name: "Fjordlys ApS",
  postalAddress: {
    street: "Strandvejen 40",
    city: "Aarhus C",
    postcode: "8000",
    region: null,
    country: "DK",
  },
  vatNumber: "DK29403473",
  companyNumber: null,
  peppolId: "0184:29403473",
};

// A Swedish buyer with nothing but its organisationsnummer: the export
// works out both the register (0007) and the Peppol address from it.
const swedishBuyer: EinvoiceSource["client"] = {
  name: "Norrsken Studio AB",
  postalAddress: {
    street: "Drottninggatan 5",
    city: "Stockholm",
    postcode: "111 51",
    region: null,
    country: "SE",
  },
  vatNumber: "SE556036079301",
  companyNumber: "556036-0793",
  peppolId: null,
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
  peppolId: null,
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
  peppolId: null,
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
  {
    // German seller, Danish buyer addressed by a typed-in Peppol ID (CVR).
    name: "danish-buyer",
    source: {
      business: seller,
      client: danishBuyer,
      invoice: {
        ...issued,
        number: "2026-0005",
        currency: "EUR",
        taxTreatment: "reverse_charge",
        taxRatePercent: "0",
        taxNote:
          "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
        vatexCode: "VATEX-EU-AE",
        subtotalMinor: 240000,
        taxMinor: 0,
        totalMinor: 240000,
        lines: [
          {
            description: "Design sprint",
            quantity: "3.000000",
            unitPriceMinor: 80000,
            totalMinor: 240000,
            unitCode: "DAY",
          },
        ],
      },
    },
  },
  {
    // Dutch seller with a KVK number, Dutch buyer whose 8-digit company
    // number goes out as a KVK number too (NL-R-003, NL-R-005).
    name: "dutch-seller",
    source: {
      business: dutchSeller,
      client: dutchBuyer,
      invoice: {
        ...issued,
        number: "2026-0006",
        currency: "EUR",
        taxTreatment: "standard",
        taxRatePercent: "21",
        taxNote: null,
        subtotalMinor: 100000,
        taxMinor: 21000,
        totalMinor: 121000,
        lines: [
          {
            description: "Maintenance, June",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 100000,
            unitCode: "MON",
          },
        ],
      },
    },
  },
  {
    // Danish seller (CVR as legal entity ID and Peppol address), Swedish
    // buyer addressed by its organisationsnummer.
    name: "danish-seller",
    source: {
      business: danishSeller,
      client: swedishBuyer,
      invoice: {
        ...issued,
        number: "2026-0007",
        currency: "DKK",
        taxTreatment: "reverse_charge",
        taxRatePercent: "0",
        taxNote:
          "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
        vatexCode: "VATEX-EU-AE",
        subtotalMinor: 1500000,
        taxMinor: 0,
        totalMinor: 1500000,
        lines: [
          {
            description: "Backend development",
            quantity: "20.000000",
            unitPriceMinor: 75000,
            totalMinor: 1500000,
            unitCode: "HUR",
          },
        ],
      },
    },
  },
];
