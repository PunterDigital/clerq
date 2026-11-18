// The invoice PDF layout. Colors are the design system's tokens by value
// (PDFs cannot read CSS variables): teal-500 #228E80 primary, warm
// neutrals #2A241F/#6E6458 text, #E8E1D8 hairlines. Typeface is the PDF
// standard Helvetica for now - self-hosted Figtree embedding is part of
// the design pass.

import {
  Document,
  Image,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

import type { InvoicePdfData } from "@/modules/billing/pdf-data";

// primary is the default; per-invoice it is overridden inline by the
// business's chosen brand colour (data.brandColor).
const colors = {
  primary: "#228E80",
  textStrong: "#2A241F",
  textMuted: "#6E6458",
  border: "#E8E1D8",
};

// One spacing scale for the whole document, so the gaps between sections
// stay in proportion when any one of them is tuned. Values are PDF points.
const space = {
  // Page margin. A4 is 595x842pt, so 56pt leaves a ~483pt column - wide
  // enough for a full line item, with a comfortable margin for printing.
  page: 56,
  // Between the major bands: header, meta, table, totals, notes, footer.
  section: 28,
  // Between a small-caps caption and the value under it.
  caption: 6,
  // Between stacked fields inside a meta column.
  field: 12,
  // Vertical breathing room inside a line-item row.
  row: 10,
};

// Helvetica draws a line box about 1.38x its font size, so anything tighter
// than that has consecutive lines overlapping the moment the text wraps.
// The page's 1.5 is comfortable for body copy; the display sizes (business
// name, title, balance) use this slightly tighter value, which still leaves
// a clear gap when they wrap onto a second line.
const displayLineHeight = 1.45;

const styles = StyleSheet.create({
  page: {
    padding: space.page,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: colors.textStrong,
    lineHeight: 1.5,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: space.section,
  },
  // The header columns are explicitly sized. Without this the business
  // block is free to grow past the middle of the page and print on top of
  // the invoice title and balance, which is what a long business name used
  // to do. The left column flexes and wraps; the right one keeps the width
  // its title and amount need.
  headerLeft: { flex: 1, paddingRight: 24 },
  headerRight: { flexShrink: 0, maxWidth: "45%", alignItems: "flex-end" },
  businessName: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
    lineHeight: displayLineHeight,
    // Clears the descenders of this line from the ascenders of the address
    // line below it, which used to touch.
    marginBottom: 10,
  },
  title: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
    lineHeight: displayLineHeight,
  },
  balanceBox: { marginTop: 20, alignItems: "flex-end" },
  balanceCaption: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: space.caption,
    textAlign: "right",
  },
  balanceAmount: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
    lineHeight: displayLineHeight,
  },
  paidBadge: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
    textAlign: "right",
    marginTop: 2,
  },
  voidBadge: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: "#B91C1C",
    textAlign: "right",
    letterSpacing: 1,
    marginTop: 2,
  },
  // Large diagonal stamp across the page so a printed voided invoice is
  // unmistakable. Low opacity keeps the content underneath legible.
  voidWatermark: {
    position: "absolute",
    top: 300,
    left: 0,
    right: 0,
    alignItems: "center",
    transform: "rotate(-24deg)",
  },
  voidWatermarkText: {
    fontSize: 150,
    fontFamily: "Helvetica-Bold",
    color: "#B91C1C",
    opacity: 0.12,
    letterSpacing: 10,
  },
  metaBlock: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: space.section,
  },
  metaColumn: { width: "46%" },
  metaCaption: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: space.caption,
  },
  // Second and subsequent captions in a meta column, spaced off the value
  // above them.
  metaCaptionStacked: { marginTop: space.field },
  metaLine: { fontSize: 10 },
  metaMuted: { fontSize: 10, color: colors.textMuted },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 8,
    marginBottom: 4,
  },
  th: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: space.row,
  },
  // The gutter keeps a description that runs the full width clear of the
  // amount column rather than butting up against it.
  cellDescription: { flex: 1, paddingRight: 20 },
  cellAmount: { width: 96, textAlign: "right" },
  lineNote: {
    fontSize: 8,
    color: colors.textMuted,
    lineHeight: 1.5,
    marginTop: 3,
  },
  totals: {
    marginTop: 20,
    marginLeft: "auto",
    width: 240,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  totalsGrand: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 8,
    paddingTop: 10,
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  taxNote: {
    marginTop: space.section,
    fontSize: 9,
    color: colors.textMuted,
    lineHeight: 1.5,
  },
  notesBlock: { marginTop: space.section },
  notesCaption: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: space.caption,
  },
  // Notes are usually a bulleted list of work done, so they get a looser
  // line box than body copy to stay scannable.
  notes: { fontSize: 9, color: colors.textMuted, lineHeight: 1.6 },
  logo: { maxWidth: 180, height: 48, objectFit: "contain", marginBottom: 14 },
  // `marginTop: "auto"` eats the leftover space on the page, which pins the
  // footer to the bottom of the last page while leaving it in the normal
  // flow. Being in the flow is the point: the footer used to be absolutely
  // positioned, so content that reached the bottom of a page printed
  // straight through it. Now the notes simply push it down, onto a new page
  // if that is what it takes.
  footer: { marginTop: "auto", paddingTop: space.section },
  // The rule and its padding sit on an inner view so the clearance above
  // the rule (the padding on `footer`) stays outside the border.
  footerRule: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  footerLine: {
    fontSize: 8,
    color: colors.textMuted,
    lineHeight: 1.5,
  },
});

// A line item is nicer to read whole, so a row is normally kept off a page
// break. But `wrap={false}` on a row that is taller than the page has
// nowhere to go: react-pdf renders it overflowing instead, printing every
// line of it over its neighbours and off the bottom of the page. Invoices
// generated from time can carry a whole period's task list in a single
// description, which is exactly that case, so a row is only kept whole when
// it is short enough to fit comfortably.
//
// The estimate below only picks between "keep whole" and "let it break", and
// it errs towards letting it break: a narrower column than the real one, so
// it over-counts lines rather than under-counting them. Ten lines is a long
// way short of the ~730pt of content a page holds, so being wrong by a wide
// margin still cannot bring the overflow back.
const DESCRIPTION_CHARS_PER_LINE = 55;
const MAX_LINES_KEPT_WHOLE = 10;

function fitsOnOnePage(description: string): boolean {
  const lines = description
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / DESCRIPTION_CHARS_PER_LINE)),
      0,
    );
  return lines <= MAX_LINES_KEPT_WHOLE;
}

export function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const noteLines = data.notes ? data.notes.split("\n") : [];

  return (
    <Document
      title={data.title}
      author={data.businessName}
      creator="Clerq"
      producer="Clerq"
    >
      <Page size="A4" style={styles.page}>
        {data.isVoid ? (
          <View style={styles.voidWatermark} fixed>
            <Text style={styles.voidWatermarkText}>VOID</Text>
          </View>
        ) : null}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {data.logoDataUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={data.logoDataUrl} style={styles.logo} />
            ) : null}
            <Text style={[styles.businessName, { color: data.brandColor }]}>
              {data.businessName}
            </Text>
            {data.businessAddressLines.map((line, index) => (
              <Text key={index} style={styles.metaMuted}>
                {line}
              </Text>
            ))}
            {data.businessVatNumber ? (
              <Text style={styles.metaMuted}>VAT {data.businessVatNumber}</Text>
            ) : null}
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.title}>{data.title}</Text>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceCaption}>Balance Due</Text>
              <Text style={[styles.balanceAmount, { color: data.brandColor }]}>
                {data.balanceDueLabel}
              </Text>
            </View>
            {data.isPaid ? (
              <Text style={[styles.paidBadge, { color: data.brandColor }]}>
                Paid
              </Text>
            ) : null}
            {data.isVoid ? <Text style={styles.voidBadge}>VOID</Text> : null}
          </View>
        </View>

        <View style={styles.metaBlock}>
          <View style={styles.metaColumn}>
            <Text style={styles.metaCaption}>Billed to</Text>
            <Text style={styles.metaLine}>{data.clientName}</Text>
            {data.clientAddressLines.map((line, index) => (
              <Text key={index} style={styles.metaMuted}>
                {line}
              </Text>
            ))}
            {data.clientCompanyNumber ? (
              <Text style={styles.metaMuted}>
                Company no. {data.clientCompanyNumber}
              </Text>
            ) : null}
            {data.clientVatNumber ? (
              <Text style={styles.metaMuted}>VAT {data.clientVatNumber}</Text>
            ) : null}
          </View>
          <View style={styles.metaColumn}>
            {data.issueDateLabel ? (
              <>
                <Text style={styles.metaCaption}>Issued</Text>
                <Text style={styles.metaLine}>{data.issueDateLabel}</Text>
              </>
            ) : null}
            {data.dueDateLabel ? (
              <>
                <Text style={[styles.metaCaption, styles.metaCaptionStacked]}>
                  Due
                </Text>
                <Text style={styles.metaLine}>{data.dueDateLabel}</Text>
              </>
            ) : null}
            {data.periodLabel ? (
              <>
                <Text style={[styles.metaCaption, styles.metaCaptionStacked]}>
                  Billing period
                </Text>
                <Text style={styles.metaLine}>{data.periodLabel}</Text>
              </>
            ) : null}
            {data.buyerReference ? (
              <>
                <Text style={[styles.metaCaption, styles.metaCaptionStacked]}>
                  Your reference
                </Text>
                <Text style={styles.metaLine}>{data.buyerReference}</Text>
              </>
            ) : null}
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={[styles.th, styles.cellDescription]}>Description</Text>
          <Text style={[styles.th, styles.cellAmount]}>Amount</Text>
        </View>
        {data.lines.map((line, index) => (
          <View
            key={index}
            style={styles.row}
            wrap={!fitsOnOnePage(line.description)}
          >
            <View style={styles.cellDescription}>
              {line.description.split("\n").map((descLine, i) => (
                <Text key={i}>{descLine || " "}</Text>
              ))}
              {line.quantityLabel ? (
                <Text style={styles.lineNote}>{line.quantityLabel}</Text>
              ) : null}
              {line.conversionNote ? (
                <Text style={styles.lineNote}>{line.conversionNote}</Text>
              ) : null}
            </View>
            <Text style={styles.cellAmount}>{line.totalLabel}</Text>
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalsRow}>
            <Text style={styles.metaMuted}>Subtotal</Text>
            <Text>{data.subtotalLabel}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.metaMuted}>{data.taxRowLabel}</Text>
            <Text>{data.taxAmountLabel}</Text>
          </View>
          <View style={styles.totalsGrand}>
            <Text>Total</Text>
            <Text>{data.totalLabel}</Text>
          </View>
        </View>

        {data.taxNote ? <Text style={styles.taxNote}>{data.taxNote}</Text> : null}
        {data.paymentLines.length > 0 ? (
          <View style={styles.notesBlock} wrap={false}>
            <Text style={styles.notesCaption}>Payment details</Text>
            {data.paymentLines.map((line, i) => (
              <Text key={i} style={styles.notes}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        {noteLines.length > 0 ? (
          <View style={styles.notesBlock}>
            {/* The caption travels with its first note, so the heading is
                never stranded alone at the foot of a page with the notes
                themselves overleaf. */}
            <View wrap={false}>
              <Text style={styles.notesCaption}>Notes</Text>
              <Text style={styles.notes}>{noteLines[0] || " "}</Text>
            </View>
            {noteLines.slice(1).map((line, i) => (
              <Text key={i} style={styles.notes}>
                {line || " "}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Not `fixed`: a fixed element repeats on every page (it was
            wrongly showing on page 1 of a multi-page invoice). Placed last
            with an auto top margin, it renders once at the bottom of the
            final page - the very bottom of the invoice. */}
        {data.footerNote ? (
          <View style={styles.footer}>
            <View style={styles.footerRule}>
              {data.footerNote.split("\n").map((line, i) => (
                <Text key={i} style={styles.footerLine}>
                  {line || " "}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export function buildInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument data={data} />);
}
