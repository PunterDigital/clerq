import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildInvoicePdfData } from "@/modules/billing/pdf-data";

import { buildInvoicePdf } from "./invoice-document";

// pdfjs needs the standard font data to measure Helvetica, and warns on
// every page it parses without it. The invoice is set entirely in the PDF
// standard fonts, so this is exactly the data it wants; resolving it through
// the package keeps it working under pnpm's nested layout.
const standardFontDataUrl = `${join(
  dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts",
  // pdfjs concatenates the font's filename onto this, so it has to end in a
  // "/" - added outside join(), which turns it into "\" on Windows and pdfjs
  // then rejects the path.
)}/`;

// The page margin the document is laid out to (styles.page padding).
const PAGE_MARGIN = 56;
// Helvetica's ascender and descender as a fraction of the font size - what
// the glyphs of a line actually occupy, which is what has to stay clear of
// the line above and below.
const ASCENDER = 0.718;
const DESCENDER = 0.207;
// Text placed within half a point of its neighbour is touching, not
// overlapping; rounding in the PDF coordinates makes exact zero brittle.
const TOLERANCE = 0.5;

type Box = {
  text: string;
  left: number;
  right: number;
  // Distances from the bottom of the page, as PDF coordinates are.
  top: number;
  bottom: number;
};

// Reads back what the renderer actually put on the page. Asserting on the
// rendered geometry is the only way to catch layout faults - the JSX and the
// stylesheet both look perfectly reasonable while text prints on top of
// other text.
async function textBoxes(pdf: Buffer): Promise<Box[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl,
    // Measure with the standard font data above rather than whatever fonts
    // the machine running the tests happens to have, so the geometry these
    // tests assert on is the same everywhere.
    useSystemFonts: false,
  }).promise;

  const pages: Box[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(
      content.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        const left = item.transform[4];
        const baseline = item.transform[5];
        return [
          {
            text: item.str,
            left,
            right: left + item.width,
            top: baseline + item.height * ASCENDER,
            bottom: baseline - item.height * DESCENDER,
          },
        ];
      }),
    );
  }
  return pages;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right - TOLERANCE &&
    b.left < a.right - TOLERANCE &&
    a.bottom < b.top - TOLERANCE &&
    b.bottom < a.top - TOLERANCE
  );
}

// Every pair of text boxes that share space on the page. The watermark is
// excluded: "VOID" is meant to print across the invoice.
function collisions(pages: Box[][]): string[] {
  const found: string[] = [];
  pages.forEach((boxes, index) => {
    const printed = boxes.filter((box) => box.text.trim() !== "VOID");
    for (let i = 0; i < printed.length; i++) {
      for (let j = i + 1; j < printed.length; j++) {
        if (overlaps(printed[i], printed[j])) {
          found.push(
            `page ${index + 1}: "${printed[i].text}" over "${printed[j].text}"`,
          );
        }
      }
    }
  });
  return found;
}

function outsideMargins(pages: Box[][], width: number, height: number) {
  return pages.flatMap((boxes, index) =>
    boxes
      .filter(
        (box) =>
          box.left < PAGE_MARGIN - TOLERANCE ||
          box.right > width - PAGE_MARGIN + TOLERANCE ||
          box.bottom < PAGE_MARGIN - TOLERANCE ||
          box.top > height - PAGE_MARGIN + TOLERANCE,
      )
      .map((box) => `page ${index + 1}: "${box.text}"`),
  );
}

// Inclusive range, for sweeping a fixture across a page break.
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// A4, in points.
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

function invoice(overrides: {
  businessName?: string;
  notes?: string | null;
  footerNote?: string | null;
  lineDescription?: string;
}) {
  return buildInvoicePdfData({
    invoice: {
      number: "2026-0100",
      status: "sent",
      currency: "EUR",
      issueDate: new Date("2026-06-11T12:00:00Z"),
      dueDate: new Date("2026-07-11T00:00:00Z"),
      periodStart: new Date("2026-05-26T00:00:00Z"),
      periodEnd: new Date("2026-06-08T00:00:00Z"),
      taxTreatment: "reverse_charge",
      taxRatePercent: "0",
      taxNote:
        "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
      subtotalMinor: 406287,
      taxMinor: 0,
      totalMinor: 406287,
      notes: overrides.notes ?? null,
      lines: [
        {
          description:
            overrides.lineDescription ??
            "Data engineering and dashboard development for the audit programme",
          quantity: "43.750000",
          unitPriceMinor: 9286,
          totalMinor: 406287,
          sourceCurrency: "GBP",
          sourceTotalMinor: 350000,
          fxRate: "1.1608",
          fxSource: "ecb",
        },
      ],
    },
    business: {
      name: overrides.businessName ?? "Studio Demo",
      address: "12 Harbour Street\nBristol BS1 4QA",
      vatNumber: "GB123456789",
      footerNote: overrides.footerNote ?? null,
    },
    client: {
      name: "Lumen Labs Ltd",
      address: "44 Riverside\nPrague 110 00",
      companyNumber: "08123456",
      vatNumber: "CZ12345678",
    },
  });
}

// Render smoke test: the document actually renders to a valid PDF buffer
// with all sections present. Content correctness lives in pdf-data tests.
describe("invoice PDF rendering", () => {
  it("renders a complete invoice to a PDF buffer", async () => {
    const data = buildInvoicePdfData({
      invoice: {
        number: "2026-0100",
        status: "paid",
        currency: "EUR",
        issueDate: new Date("2026-06-11T12:00:00Z"),
        dueDate: new Date("2026-07-11T00:00:00Z"),
        periodStart: new Date("2026-05-26T00:00:00Z"),
        periodEnd: new Date("2026-06-08T00:00:00Z"),
        taxTreatment: "reverse_charge",
        taxRatePercent: "0",
        taxNote:
          "VAT reverse charged to the recipient under Article 196 of Council Directive 2006/112/EC",
        subtotalMinor: 76077,
        taxMinor: 0,
        totalMinor: 76077,
        notes: "Payment within 30 days. Thank you.",
        lines: [
          {
            description: "Demo Maker - 80.00 GBP/h",
            quantity: "5.500000",
            unitPriceMinor: 9278,
            totalMinor: 51027,
            sourceCurrency: "GBP",
            sourceTotalMinor: 44000,
            fxRate: "1.1597",
            fxSource: "ecb",
          },
          {
            description: "Hosting (March)",
            quantity: null,
            unitPriceMinor: null,
            totalMinor: 25050,
            sourceCurrency: null,
            sourceTotalMinor: null,
            fxRate: null,
            fxSource: null,
          },
        ],
      },
      business: {
        name: "Studio Demo",
        address: "12 Harbour Street\nBristol BS1 4QA",
        vatNumber: "GB123456789",
      },
      client: {
        name: "Lumen Labs Ltd",
        address: "44 Riverside\nPrague 110 00",
        companyNumber: "08123456",
        vatNumber: "CZ12345678",
      },
    });

    const pdf = await buildInvoicePdf(data);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // A real one-page invoice with embedded structure is comfortably
    // larger than a trivial empty document.
    expect(pdf.length).toBeGreaterThan(2000);
  });
});

// Layout regressions, all of which shipped at one point: the invoice looked
// fine on a short invoice and printed text over text on a real one.
describe("invoice PDF layout", () => {
  it("keeps a long business name clear of the invoice title", async () => {
    const pdf = await buildInvoicePdf(
      invoice({
        businessName:
          "Punter Digital Consulting, Data Engineering & Clinical Audit Services (Northern Division) Limited",
      }),
    );

    const pages = await textBoxes(pdf);
    // The header used to have no column widths, so the business block grew
    // straight across the page and printed over the title and balance.
    expect(collisions(pages)).toEqual([]);
    expect(outsideMargins(pages, A4_WIDTH, A4_HEIGHT)).toEqual([]);
  });

  it("never prints notes over the footer when they fill the page", async () => {
    // The footer used to be pinned to the bottom of the page out of the
    // normal flow, so content that reached that far printed straight through
    // it. It only showed up when the notes happened to end inside the footer
    // band, so this walks the notes down through it a line at a time.
    // Notes are set on a 14.4pt line and the footer block stands about 62pt
    // tall, so six consecutive fills are enough to guarantee one of them ends
    // inside the footer band - which is the only place the fault showed.
    const counts = range(26, 31);
    const rendered = await Promise.all(
      counts.map(async (count) => {
        const notes = Array.from(
          { length: count },
          (_, i) => `- Audit workstream item ${i + 1} delivered during the period`,
        ).join("\n");

        return textBoxes(
          await buildInvoicePdf(
            invoice({
              notes,
              footerNote:
                "Studio Demo, registered in England & Wales no. 08123456.\nBank details on request. Please quote the invoice number.",
            }),
          ),
        );
      }),
    );

    rendered.forEach((pages, i) => {
      const where = `${counts[i]} notes`;
      expect(collisions(pages), where).toEqual([]);
      expect(outsideMargins(pages, A4_WIDTH, A4_HEIGHT), where).toEqual([]);

      // The footer is the last thing on the invoice, and appears once.
      const footerPages = pages.flatMap((boxes, index) =>
        boxes.some((box) => box.text.includes("registered in England"))
          ? [index]
          : [],
      );
      expect(footerPages, where).toEqual([pages.length - 1]);
    });
  });

  it("lets a line item taller than the page break across pages", async () => {
    // An invoice generated from a period's tracked time carries the whole
    // task list in one line description. A row that tall cannot be kept off
    // a page break - there is no page it fits on - and asking for it anyway
    // had react-pdf render the row overflowing, printing every line of it
    // over its neighbours and off the bottom of the page.
    const tasks = [
      "- Expanded Data Validation Spreadsheet to validate Unmatched Procedure Codes",
      "- Uploaded Procedure Code Matching Spreadsheet",
      "- Created data validation spreadsheet to independently verify statistics of data validation script",
      "- Processed the quarterly audit",
      "- Added an hourly refresh to the dataset",
      "- Modified the pre-processing script to handle genders as numbers correctly",
      "- Modified the validation script to only touch the note and report columns if an anonymisation step was taken",
      "- Swapped the dashboard KPIs to grades instead of modalities",
    ];

    // Long enough that the description alone runs past a full page, and
    // again as one unbroken paragraph, which is the other shape the
    // generator produces.
    const asLines = `Demo Maker - 80.00 GBP/h\n${Array.from({ length: 8 }, () => tasks)
      .flat()
      .join("\n")}`;
    const asParagraph = `Demo Maker - 80.00 GBP/h (${Array.from(
      { length: 8 },
      () => tasks,
    )
      .flat()
      .join(", ")})`;

    const shapes = { "one line per task": asLines, "one paragraph": asParagraph };
    const rendered = await Promise.all(
      Object.entries(shapes).map(async ([name, lineDescription]) => [
        name,
        await textBoxes(await buildInvoicePdf(invoice({ lineDescription }))),
      ] as const),
    );

    for (const [name, pages] of rendered) {
      expect(pages.length, name).toBeGreaterThan(1);
      expect(collisions(pages), name).toEqual([]);
      expect(outsideMargins(pages, A4_WIDTH, A4_HEIGHT), name).toEqual([]);
    }
  });

  it("keeps the notes caption with its first note", async () => {
    // A caption alone at the foot of a page, with the notes it introduces
    // overleaf, reads as a mistake. Where the block falls depends on how
    // much else is on the page, so this walks it across the page break.
    // Six consecutive fills, for the same reason as above: enough to walk the
    // caption across the page break wherever it happens to fall.
    const lengths = range(24, 29);
    const rendered = await Promise.all(
      lengths.map(async (length) => {
        const notes = Array.from(
          { length },
          (_, i) => `- Audit workstream item ${i + 1}`,
        ).join("\n");

        return textBoxes(
          await buildInvoicePdf(invoice({ notes, footerNote: "Thank you." })),
        );
      }),
    );

    rendered.forEach((pages, i) => {
      const captionPage = pages.findIndex((boxes) =>
        boxes.some((box) => box.text === "NOTES"),
      );
      expect(
        pages[captionPage].some((box) => box.text.startsWith("- Audit")),
        `${lengths[i]} notes`,
      ).toBe(true);
    });
  });
});
