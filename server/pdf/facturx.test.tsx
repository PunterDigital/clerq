// Factur-X invoice PDFs (#5041). Every e-invoice fixture becomes a PDF/A-3b
// with factur-x.xml attached; with FACTURX_OUT set the PDFs are also written
// there, for the CI job that runs Mustang (veraPDF + the Factur-X rules)
// over them (scripts/validate-facturx.sh).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { PostalAddress } from "@/lib/postal-address";
import { buildInvoicePdfData } from "@/modules/billing/pdf-data";
import { buildCiiInvoice } from "@/modules/einvoice/cii";
import { EINVOICE_FIXTURES } from "@/modules/einvoice/fixtures";
import { buildEinvoiceModel, type EinvoiceSource } from "@/modules/einvoice/model";

import { buildInvoicePdf } from "./invoice-document";
import { FACTURX_FILENAME } from "./pdfa";

const OUT = process.env.FACTURX_OUT;

function freeText(address: PostalAddress | null): string | null {
  if (!address) return null;
  return [address.street, [address.postcode, address.city].filter(Boolean).join(" "), address.country]
    .filter(Boolean)
    .join("\n");
}

function pdfDataFor(source: EinvoiceSource) {
  return buildInvoicePdfData({
    invoice: {
      ...source.invoice,
      lines: source.invoice.lines.map((line) => ({
        ...line,
        sourceCurrency: null,
        sourceTotalMinor: null,
        fxRate: null,
        fxSource: null,
      })),
    },
    business: {
      name: source.business.name,
      address: freeText(source.business.postalAddress),
      vatNumber: source.business.vatNumber,
      iban: source.business.iban,
      bic: source.business.bic,
    },
    client: {
      name: source.client.name,
      address: freeText(source.client.postalAddress),
      companyNumber: source.client.companyNumber,
      vatNumber: source.client.vatNumber,
    },
  });
}

function streamText(doc: PDFDocument, value: unknown): string {
  const stream = value instanceof PDFStream ? value : doc.context.lookup(value as never);
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  throw new Error("not a stream");
}

function xmpOf(doc: PDFDocument): string {
  return streamText(doc, doc.catalog.get(PDFName.of("Metadata")));
}

// The file specs in the catalog's /AF array, with their embedded XML.
function associatedFiles(doc: PDFDocument) {
  const af = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  if (!af) return [];
  return af.asArray().map((ref) => {
    const spec = doc.context.lookup(ref, PDFDict);
    const ef = spec.lookup(PDFName.of("EF"), PDFDict);
    const file = doc.context.lookup(ef.get(PDFName.of("F")));
    if (!(file instanceof PDFRawStream)) throw new Error("no embedded file stream");
    return {
      name: spec.lookup(PDFName.of("F"))?.toString(),
      relationship: spec.get(PDFName.of("AFRelationship"))?.toString(),
      subtype: file.dict.get(PDFName.of("Subtype"))?.toString(),
      xml: streamText(doc, ef.get(PDFName.of("F"))),
    };
  });
}

describe("Factur-X invoice PDFs", () => {
  if (OUT) mkdirSync(OUT, { recursive: true });

  for (const { name, source } of EINVOICE_FIXTURES) {
    it(`embeds factur-x.xml for ${name}`, { timeout: 30000 }, async () => {
      const result = buildEinvoiceModel(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cii = buildCiiInvoice(result.model);

      const pdf = await buildInvoicePdf(pdfDataFor(source), { facturX: cii });
      if (OUT) writeFileSync(join(OUT, `${name}.pdf`), pdf);

      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      const files = associatedFiles(doc);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        name: `(${FACTURX_FILENAME})`,
        relationship: "/Alternative",
        subtype: "/text#2Fxml",
        xml: cii,
      });

      const xmp = xmpOf(doc);
      expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");
      expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
      expect(xmp).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>");
      expect(xmp).toContain(`<fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>`);
    });
  }

  it("leaves a PDF without e-invoice data as plain PDF/A-3b", { timeout: 30000 }, async () => {
    const pdf = await buildInvoicePdf(pdfDataFor(EINVOICE_FIXTURES[0].source));
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(associatedFiles(doc)).toEqual([]);
    const xmp = xmpOf(doc);
    expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(xmp).not.toContain("fx:");
  });

  it("escapes the business name in the XMP metadata", { timeout: 30000 }, async () => {
    const source = EINVOICE_FIXTURES[0].source;
    const pdf = await buildInvoicePdf(
      pdfDataFor({ ...source, business: { ...source.business, name: `Smith & Sons <"Ltd">` } }),
    );
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getAuthor()).toBe(`Smith & Sons <"Ltd">`);
    const xmp = xmpOf(doc);
    expect(xmp).toContain("<rdf:li>Smith &amp; Sons &lt;&quot;Ltd&quot;&gt;</rdf:li>");
    expect(xmp).not.toContain("Smith & Sons");
  });

  it("embeds every font (PDF/A)", { timeout: 30000 }, async () => {
    const pdf = await buildInvoicePdf(pdfDataFor(EINVOICE_FIXTURES[0].source));
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const fonts = doc.context
      .enumerateIndirectObjects()
      .map(([, obj]) => obj)
      .filter((obj): obj is PDFDict => obj instanceof PDFDict && obj.get(PDFName.of("Type"))?.toString() === "/FontDescriptor");
    expect(fonts.length).toBeGreaterThan(0);
    for (const descriptor of fonts) {
      expect(descriptor.get(PDFName.of("FontFile2"))).toBeDefined();
    }
  });
});
