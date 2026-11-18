# Spike: EU e-invoicing

Status: research only, no product change. Written 18 Nov 2026 against `main` at `1417acc`.
Sources are linked inline; **(2°)** marks a secondary source (law firm, vendor, news) where a
primary one couldn't be read. Dates in this area move often: re-check the national table
before building anything that depends on it.

## Summary

- An "e-invoice" in the EU sense is **structured data** following the European standard
  **EN 16931**, not a PDF. A PDF only counts when it carries the XML inside it (Factur-X /
  ZUGFeRD).
- Two outputs cover most of what Clerq's users will meet before 2028:
  1. **UBL 2.1 XML in the Peppol BIS Billing 3.0 flavour**, which is what Belgium (since
     1 Jan 2026), Slovakia (2027) and public-sector buyers almost everywhere expect, sent over
     the **Peppol** network.
  2. **Factur-X / ZUGFeRD PDFs with the EN16931 profile** (PDF/A-3 with CII XML embedded),
     which Germany (issuing from 2027/2028) and France (from Sept 2026/2027) accept.
- Poland (KSeF), Italy (SdI), Croatia, Greece, Romania and Spain run national platforms with
  their own APIs. Each is a separate integration; leave them until a user needs one.
- Clerq's invoice data maps onto EN 16931 well. The proof of concept below shows exactly what's
  missing: **structured addresses with a country code, unit codes on lines, a buyer reference,
  and (for Peppol only) electronic addresses**. With those filled, a Clerq-shaped invoice
  passes the official EN 16931 and Peppol rules with zero errors.
- Sending over Peppol needs a contract with a certified access-point provider (a paid
  service). That's a decision for later and isn't needed for steps 1 to 4 below.

## Recommended order of work

| # | Step | Size | Notes |
|---|---|---|---|
| 1 | Structured addresses (street, city, postcode, region, ISO country) for the business and clients, kept next to the current free-text field | M | Existing rows keep their text and get a best-effort split the user confirms; the PDF keeps printing what it prints today |
| 2 | E-invoice fields: line unit codes (hours `HUR`, fixed `C62`, days `DAY`), optional buyer reference / PO number (client default + per invoice), VATEX exemption codes next to the tax notes, optional IBAN/BIC | S | All optional in the UI; required only when an e-invoice is produced |
| 3 | UBL 2.1 (Peppol BIS 3.0) export: "Download e-invoice (XML)" on issued invoices + API/MCP, validated in CI against the CEN and Peppol rules | M | No network service involved |
| 4 | Factur-X EN16931 PDF: render the existing PDF as PDF/A-3b, embed the CII XML, check with veraPDF + Mustang in CI | M | Makes every sent PDF a valid German/French e-invoice |
| 5 | Credit notes (type 381) for issued invoices, instead of voiding | M | Product change: e-invoicing rules don't allow cancelling an issued invoice; a correction is a credit note. Needs a decision |
| 6 | Peppol sending and receiving through an access-point provider | M-L | Paid service: needs a decision on provider and pricing first |

National platforms (KSeF, SdI, myDATA, e-Factura, Croatia's fiscalisation, Spain's SPFE and
Verifactu) are out of scope until a user in one of those countries asks.

## The standard

- **EN 16931-1:2017** is the semantic model (business terms `BT-n`, groups `BG-n`). It is
  bound to two XML syntaxes: **UBL 2.1** and **UN/CEFACT CII D16B**. The official rules are
  Schematron files, published by CEN/TC 434 as the
  [validation artefacts, v1.3.17 (12 Oct 2026)](https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/tag/validation-1.3.17).
- A **CIUS** narrows the standard (makes optional fields mandatory, restricts code lists)
  and stays compliant. **Peppol BIS Billing 3.0**
  ([docs](https://docs.peppol.eu/poacc/billing/3.0/bis/), rules 3.0.22, 4 Nov 2026) and
  Germany's **XRechnung 3.0.x** ([KoSIT](https://xeinkauf.de/xrechnung/)) are both CIUSes.
- **EN 16931-1:2026** was approved by CEN in March 2026
  ([EC newsroom](https://ec.europa.eu/newsroom/digital/items/930407/en)); the Commission will
  publish it with a transition phase. One provider expects Peppol to adopt it in BIS Billing
  4.0 in 2027 and says it isn't backward-compatible
  ([eConnect](https://econnect.eu/en/docs/knowledge/document-formats/formats/en-16931-2026-wijzigingen) (2°)).
  The current artefacts and Peppol still implement 2017. **Build to 2017 / BIS 3.0, and keep
  the mapping in one module so a second version can sit next to it.**

### What an invoice must carry

Unconditionally required by the CEN rules (`BR-*`):

| Term | What | Rule |
|---|---|---|
| BT-24 | Specification identifier | BR-01 |
| BT-1, BT-2, BT-3, BT-5 | Number, issue date, type code (380 invoice, 381 credit note), currency | BR-02 to BR-05 |
| BT-27, BG-5, BT-40 | Seller name, postal address, **country code** (ISO 3166-1) | BR-06, BR-08, BR-09 |
| BT-44, BG-8, BT-55 | Buyer name, postal address, **country code** | BR-07, BR-10, BR-11 |
| BT-106, 109, 112, 115 | Line total, total without VAT, total with VAT, amount due | BR-12 to BR-15 |
| BG-23 | VAT breakdown per category: taxable amount, tax, category code, rate | BR-CO-18, BR-45 to BR-48 |
| BG-25 | Lines: ID, quantity, **unit code** (UN/ECE Rec 20/21), net amount, item name, net price, VAT category | BR-16, BR-21 to BR-27 |

Conditional rules Clerq will hit:

- At least one seller identifier: VAT ID, legal registration or seller ID (BR-CO-26).
- Standard/zero-rated lines need the seller's VAT ID (BR-S-02, BR-Z-02).
- **Reverse charge (`AE`)** needs the buyer's VAT ID or legal registration (BR-AE-02) and an
  exemption reason (text or VATEX code). Clerq already requires both VAT numbers for reverse
  charge.
- Intra-community supply (`K`) also needs a delivery date or period and a deliver-to country.
- Payment instructions, when present, need a payment means code (UNCL4461: 30 credit
  transfer, 58 SEPA credit transfer) and, for a transfer, an account ID (BR-49, BR-50).
- **Peppol** adds: a buyer reference or order reference (R003), and both parties'
  electronic addresses with a scheme (R010, R020).
- **XRechnung** (German public buyers) adds: buyer reference = Leitweg-ID (BR-DE-15), payment
  instructions, a seller contact with name, phone and email
  ([KoSIT Schematron](https://github.com/itplr-kosit/xrechnung-schematron/blob/master/src/validation/schematron/ubl/XRechnung-UBL-validation.sch)).

VAT categories ([UNCL5305](https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL5305/)):
`S` standard, `Z` zero rated, `E` exempt, `AE` reverse charge, `K` intra-community supply,
`G` export, `O` outside scope (plus `L`, `M`, `B` for Canaries, Ceuta/Melilla, Italy).

## Mandates

**ViDA** ([Directive (EU) 2025/516](https://eur-lex.europa.eu/eli/dir/2025/516/oj), in
force 14 Apr 2025): member states may now require domestic e-invoicing without asking
Brussels for a derogation. From **1 Jul 2030**, intra-EU B2B invoices must be EN 16931
e-invoices with digital reporting, issued within 10 days; countries with older real-time
systems have until 1 Jan 2035 to align
([EC TAXUD](https://taxation-customs.ec.europa.eu/taxation/vat/vat-digital-age-vida_en)).

| Country | What | Dates | Channel |
|---|---|---|---|
| Belgium | Domestic B2B, issue + receive | Live 1 Jan 2026; fines from 1 Apr 2026 (2°) | **Peppol** ([einvoice.belgium.be](https://einvoice.belgium.be/en)) |
| Germany | Domestic B2B | Receive since 1 Jan 2025; issue from 1 Jan 2027 (prior-year turnover > €800k), 1 Jan 2028 for all; small-business scheme and ≤ €250 invoices exempt | Any channel incl. email; XRechnung, ZUGFeRD (not MINIMUM / BASIC WL) ([EC DE](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Germany), [IHK Köln](https://www.ihk.de/koeln/hauptnavigation/recht-steuern/steuern/bmf-schreiben-zur-e-rechnung-vom-15-10-2025-6774012)) |
| France | Domestic B2B + e-reporting | All receive 1 Sep 2026; large/mid issue 1 Sep 2026; SMEs and micro 1 Sep 2027 | Approved platforms (PA); UBL, CII or Factur-X ([impots.gouv](https://www.impots.gouv.fr/actualite/facturation-electronique)) |
| Poland | All invoices in KSeF | 1 Feb 2026 large, 1 Apr 2026 others, 1 Jan 2027 smallest | KSeF clearance, own FA(3) XML ([ksef.podatki.gov.pl](http://ksef.podatki.gov.pl/etapy-wdrozenia-ksef/)) |
| Spain | Domestic B2B | 6 Oct 2027 (turnover > €8m), 6 Oct 2028 others; Verifactu reportedly moved to Oct 2028 (not confirmed in force) | Private platforms + AEAT's (UBL) ([BOE RD 238/2026](https://www.boe.es/eli/es/rd/2026/03/25/238), [CMS](https://cms.law/en/esp/publication/factura-electronica-b2b-arranca-la-cuenta-atras-y-veri-factu-se-aplaza-a-2028) (2°)) |
| Italy | B2B + B2C | Since 2019 | SdI, FatturaPA XML ([EC IT](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Italy)) |
| Portugal | B2G only; no B2B mandate | PDF B2B invoices fine by agreement; certified software, ATCUD + QR code, SAF-T; dates for qualified signatures on PDFs conflict (2026/2027) | Portal BASE / FE-AP, CIUS-PT ([EC PT](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Portugal)) |
| Croatia | Domestic B2B | VAT-registered 1 Jan 2026; others issue 1 Jan 2027 | Intermediaries + fiscalisation ([Porezna uprava](https://porezna-uprava.gov.hr/hr/vodic-kroz-fiskalizaciju-2-0/8149)) |
| Greece | Domestic B2B | > €1m turnover 2 Mar 2026; others 2 Nov 2026; certified providers only from 1 Feb 2027 (2°) | myDATA ([EY GR](https://www.ey.com/el_gr/technical/tax/tax-alerts/nees-prothesmies-ilektroniki-timologisi-psifiaka-parastatika-diakinisis) (2°)) |
| Romania | B2B, B2C | Since 2024 / 2025 | RO e-Factura, CIUS-RO on UBL ([EC RO](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Romania)) |
| Slovakia | Domestic B2B | 1 Jan 2027 | **Peppol** ([EC SK](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Slovakia)) |
| Latvia, Slovenia | Domestic B2B | 1 Jan 2028 | Peppol / providers ([EC LV](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Latvia), [EC SI](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Slovenia)) |
| Estonia | Buyer may demand an e-invoice | Since Jul 2025 | Operators + Peppol ([EC EE](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Estonia)) |

The UK (outside the EU) has no mandate; Clerq's current PDFs stay valid there.

## What Clerq has today, against EN 16931

Mapped from `db/schema.ts` (business, client, invoice, invoiceLine), `modules/billing/tax.ts`
and `modules/billing/pdf-data.ts`.

| EN 16931 needs | Clerq today | Gap |
|---|---|---|
| Seller name, VAT ID (BT-27, BT-31) | `business.name`, `taxConfig.vatNumber` | none (VAT ID stays optional in Clerq; most real e-invoices need it) |
| Seller address with country (BG-5, BT-40) | `business.address`, one free-text field | **structured address**: street, city, postcode, ISO country |
| Buyer name, VAT ID (BT-44, BT-48) | `client.name`, `client.vatNumber` | none |
| Buyer address with country (BG-8, BT-55) | `client.address`, free text | **structured address** |
| Buyer legal registration (BT-47) | `client.companyNumber` | none (its scheme ID is optional) |
| Number, issue date, currency, type (BT-1, 2, 5, 3) | `invoice.number`, `issueDate`, `currency` | type code 380 is a constant |
| Due date (BT-9) | `invoice.dueDate` | none |
| Buyer or order reference (Peppol R003; XRechnung's Leitweg-ID) | nothing | **new optional field**: client default + per invoice |
| Electronic addresses (BT-34, BT-49) | nothing | **Peppol participant ID** (scheme + value) on the business and clients; only for Peppol |
| VAT category + breakdown (BT-151, BG-23) | one treatment per invoice: standard → `S`, zero_rated → `Z`, reverse_charge → `AE` | maps one to one, one breakdown row. `E`, `K`, `G`, `O` would be new treatments |
| Exemption reason (BT-120/121) | `invoice.taxNote` (text) | add the VATEX code (`VATEX-EU-AE` for reverse charge) |
| Line quantity + **unit code** (BT-129/130) | `quantity` (decimal hours, or null) | **unit code**: `HUR` for time, `C62` for fixed lines |
| Line net price (BT-146) | `unitPriceMinor` (null on fixed lines) | fixed lines: quantity 1, price = line total |
| Totals (BG-22) | `subtotalMinor`, `taxMinor`, `totalMinor` | none: tax is computed once on the subtotal, as the rules expect |
| Payment instructions (BG-16, optional) | nothing | optional IBAN/BIC on the business |
| Corrections: credit note (381) pointing at the invoice | voiding keeps the number and marks it void | **credit notes** (step 5) |

Not gaps: fractional hours, any ISO 4217 currency, the `YYYY-NNNN` numbering, and FX notes
(those stay on the PDF).

## Proof of concept

A throwaway script (not merged) built UBL 2.1 in the Peppol BIS 3.0 flavour from a
reverse-charge invoice shaped exactly like Clerq's rows: two parties with free-text
addresses and VAT numbers, a time line of 12.5 h, a fixed-fee line and a 4.083333 h line
whose total is rounded once (326.67), as `modules/time` produces. It then built the same
invoice with the gaps filled. Both were validated in Docker (`eclipse-temurin:21-jdk`,
Saxon-HE 10.9) against the CEN EN 16931 UBL artefacts 1.3.17 and the Peppol BIS rules at
3.0.22 (compiled from Schematron with SchXslt 1.10.1).

| File | EN 16931 rules | Peppol BIS rules |
|---|---|---|
| Clerq's data as stored today | 9 fatal | 5 fatal |
| Same invoice, gaps filled | **0** | **0** |

Today's failures:

- No country code in either address: BR-09, BR-11, BR-CL-14 ×2. Splitting the free text into
  address lines also hit UBL-SR-51 (only one third line allowed): the text can't simply be
  passed through.
- No unit of measure: BR-CL-23 on all three lines.
- No buyer or order reference: PEPPOL-EN16931-R003.
- No electronic addresses: PEPPOL-EN16931-R020 (seller), R010 (buyer).
- The empty country element: PEPPOL-EN16931-R008.

The filled version only added structured addresses, unit codes, a buyer reference and
Peppol endpoint IDs (and an IBAN, which isn't required). The rounded 4.083333 h line passed
Peppol's line-amount check, so Clerq's money model needs no change.

## How to build it

**XML.** Write the mapping ourselves in a `modules/einvoice` module (Clerq data → an EN 16931
object → UBL or CII), or use [`@e-invoice-eu/core`](https://github.com/gflohr/e-invoice-eu)
(3.4.4, Nov 2026, WTFPL; JSON in, UBL/CII/XRechnung/Factur-X out). The mapping is small and is
where the business rules live, so owning it is reasonable; the library is worth a look for
the PDF step.

**Factur-X PDF.** `@react-pdf/renderer` 4.9.0 (already Clerq's version) has a `conformance`
prop on `<Document>` that produces PDF/A-3b, with registered fonts embedded
([releases](https://github.com/diegomura/react-pdf/releases)). It has no attachment API, so
the CII XML is embedded afterwards (`AFRelationship=Alternative`, Factur-X XMP metadata) with
the maintained [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib) fork (MIT).
Plain `pdf-lib` hasn't shipped since 2021 and has no PDF/A support. Target the **EN16931**
profile: valid in Germany and France, and one to one with the model.

**Validation in CI.** Generate fixtures from seeded invoices and check them in Docker:

| Tool | Checks | Licence |
|---|---|---|
| CEN EN 16931 artefacts ([1.3.17](https://github.com/ConnectingEurope/eInvoicing-EN16931/releases)) | core rules, UBL + CII (precompiled XSLT) | EUPL-1.2 (run as a tool) |
| Peppol BIS rules ([3.0.22](https://github.com/OpenPeppol/peppol-bis-invoice-3/releases)) | Peppol CIUS | Schematron, compiled at test time |
| KoSIT validator ([1.6.3](https://github.com/itplr-kosit/validator/releases)) + [BIS](https://github.com/itplr-kosit/validator-configuration-bis/releases) / [XRechnung](https://github.com/itplr-kosit/validator-configuration-xrechnung/releases) configs | the reference check used in Germany | Apache-2.0, JAR only (no official image) |
| [Mustang](https://github.com/ZUGFeRD/mustangproject/releases) | Factur-X / ZUGFeRD XML + PDF | Apache-2.0 |
| [veraPDF](https://hub.docker.com/r/verapdf/cli) | PDF/A-3 conformance | GPL-3.0 (run as a tool) |

The proof of concept's approach (Saxon + the CEN XSLT + SchXslt for Peppol) took about a
minute in a JDK container, including downloads; caching the jars makes it a few seconds.

**Peppol.** Four-corner model: our access point looks up the buyer's participant ID in the
SML/SMP and sends over AS4 to the buyer's access point
([OpenPeppol eDelivery](https://docs.peppol.eu/edelivery/)). Becoming an access point means
OpenPeppol membership, certification and running AS4 infrastructure; a small SaaS uses a
certified provider instead ([list](https://peppol.org/members/peppol-certified-service-providers/)).
Providers with public developer APIs include Storecove, B2Brouter, eConnect, ecosio, Qvalia
and Invopop. Receiving means the provider registers each Clerq business in its SMP and pushes
inbound invoices by webhook. Participant IDs are `<EAS scheme>:<id>`, e.g. `9925` Belgian VAT,
`0208` Belgian enterprise number, `9930` German VAT
([EAS list](https://docs.peppol.eu/poacc/billing/3.0/codelist/eas/)).

## Licences

Clerq is AGPL-3.0. Fine to depend on: MIT, Apache-2.0, WTFPL. EUPL-1.2 (the CEN artefacts,
`@stackforge-eu/factur-x`) lists AGPL as a compatible licence, but keep artefacts as CI tools
rather than shipped code. GPL-3.0 veraPDF stays a CI container. Avoid `saxon-js` in the
product (Saxonica's own licence), which rules out `@stafyniaksacha/facturx` as a dependency.

## Open questions

1. When EN 16931-1:2026 and Peppol BIS 4.0 become mandatory, and what breaks.
2. BR-CO-25 (due date or payment terms when an amount is due) is described in the standard
   but isn't in the CEN 1.3.17 Schematron. Clerq always has a due date, so it's moot for now.
3. France: whether Factur-X BASIC WL is accepted during the transition (EN16931 is, so the
   plan doesn't depend on it).
4. Spain: whether Verifactu's move to Oct 2028 is formally in force.
5. Germany: the BMF letters couldn't be loaded; the MINIMUM/BASIC WL exclusion comes from
   PwC and IHK summaries.
6. Portugal: the SME B2G date and the qualified-signature date for PDF invoices conflict
   between sources.
7. Peppol provider choice and pricing: not researched; needed before step 6.
