// Finishes the invoice PDF that react-pdf renders as PDF/A-3b (#5041):
//   - writes the XMP metadata again from the Info dictionary, escaped.
//     pdfkit pastes the title and author into its XMP unescaped, so a
//     business called "Smith & Sons" made the metadata invalid XML (and
//     the file no longer PDF/A).
//   - for an issued e-invoice, embeds the CII XML as factur-x.xml
//     (AFRelationship Alternative, listed in the catalog's /AF) and adds
//     the Factur-X extension schema and fx: properties to the XMP, which is
//     what makes the PDF a Factur-X / ZUGFeRD invoice (EN 16931 profile).
// @cantoo/pdf-lib is MIT.

import { AFRelationship, PDFDocument, PDFName } from "@cantoo/pdf-lib";

export const FACTURX_FILENAME = "factur-x.xml";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// XMP dates: ISO 8601 to the second, UTC (the Info dictionary's dates are
// written in UTC too, so both say the same instant).
function xmpDate(d: Date): string {
  return `${d.toISOString().split(".")[0]}Z`;
}

// The Factur-X 1.0.07 / ZUGFeRD 2.3 extension schema. PDF/A only allows
// properties outside its predefined schemas when they are declared here.
const FACTURX_SCHEMA = `
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
<pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
<pdfaSchema:prefix>fx</pdfaSchema:prefix>
<pdfaSchema:property><rdf:Seq>
${[
  ["DocumentFileName", "The name of the embedded XML document"],
  ["DocumentType", "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER"],
  ["Version", "The actual version of the standard applying to the embedded XML document"],
  ["ConformanceLevel", "The conformance level of the embedded XML document"],
]
  .map(
    ([name, description]) =>
      `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${description}</pdfaProperty:description></rdf:li>`,
  )
  .join("\n")}
</rdf:Seq></pdfaSchema:property>
</rdf:li></rdf:Bag></pdfaExtension:schemas>
</rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
<fx:DocumentType>INVOICE</fx:DocumentType>
<fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>
<fx:Version>1.0</fx:Version>
<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
</rdf:Description>`;

function buildXmp(doc: PDFDocument, facturX: boolean): string {
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const creator = doc.getCreator();
  const producer = doc.getProducer();
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
    "<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>",
    "</rdf:Description>",
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    created ? `<xmp:CreateDate>${xmpDate(created)}</xmp:CreateDate>` : "",
    modified ? `<xmp:ModifyDate>${xmpDate(modified)}</xmp:ModifyDate>` : "",
    creator ? `<xmp:CreatorTool>${esc(creator)}</xmp:CreatorTool>` : "",
    "</rdf:Description>",
    title || author
      ? '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        (title
          ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>`
          : "") +
        (author ? `<dc:creator><rdf:Seq><rdf:li>${esc(author)}</rdf:li></rdf:Seq></dc:creator>` : "") +
        "</rdf:Description>"
      : "",
    '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    producer ? `<pdf:Producer>${esc(producer)}</pdf:Producer>` : "",
    "</rdf:Description>",
    facturX ? FACTURX_SCHEMA : "",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ]
    .filter(Boolean)
    .join("\n");
}

export async function finishPdfA(
  pdf: Uint8Array,
  options: { facturX?: string | null } = {},
): Promise<Buffer> {
  // updateMetadata: false keeps the Info dictionary as react-pdf wrote it;
  // the XMP below is built from it, so the two match (PDF/A 6.6.2.3).
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const facturX = options.facturX ?? null;

  const xmp = doc.context.stream(new TextEncoder().encode(buildXmp(doc, facturX !== null)), {
    Type: "Metadata",
    Subtype: "XML",
  });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));

  if (facturX !== null) {
    const when = doc.getCreationDate() ?? new Date();
    await doc.attach(new TextEncoder().encode(facturX), FACTURX_FILENAME, {
      mimeType: "text/xml",
      description: "Factur-X invoice (EN 16931)",
      creationDate: when,
      modificationDate: when,
      afRelationship: AFRelationship.Alternative,
    });
  }

  return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
}
