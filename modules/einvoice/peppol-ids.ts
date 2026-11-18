// Peppol electronic addresses (EN 16931 BT-34 seller / BT-49 buyer) are
// "<EAS scheme>:<id>". Clerq has no separate Peppol ID yet, so the export
// derives one from the party's VAT number, using the country's VAT-number
// scheme from the Peppol EAS code list (structure/codelist/eas.xml in
// OpenPeppol/peppol-bis-invoice-3 at 3.0.22). Countries whose Peppol scheme
// is a registry number rather than the VAT number (Denmark, Finland,
// Sweden, Norway, Iceland) have no entry: the export says so instead of
// guessing.

// ISO 3166-1 alpha-2 country -> EAS scheme for that country's VAT number.
export const VAT_EAS_SCHEMES: Readonly<Record<string, string>> = {
  AD: "9922",
  AL: "9923",
  AT: "9914",
  BA: "9924",
  BE: "9925",
  BG: "9926",
  CH: "9927",
  CY: "9928",
  CZ: "9929",
  DE: "9930",
  EE: "9931",
  ES: "9920",
  FR: "9957",
  GB: "9932",
  GR: "9933",
  HR: "9934",
  HU: "9910",
  IE: "9935",
  IT: "0211",
  LI: "9936",
  LT: "9937",
  LU: "9938",
  LV: "9939",
  MC: "9940",
  ME: "9941",
  MK: "9942",
  MT: "9943",
  NL: "9944",
  PL: "9945",
  PT: "9946",
  RO: "9947",
  RS: "9948",
  SI: "9949",
  SK: "9950",
  SM: "9951",
  TR: "9952",
  VA: "9953",
};

// The VAT number as EN 16931 wants it (BR-CO-09): no spaces or dots, upper
// case, with the country prefix. Greece's VAT prefix is EL, not GR.
export function normalizeVatId(vat: string, country: string): string {
  const compact = vat.replace(/[\s.\-]/g, "").toUpperCase();
  if (/^[A-Z]{2}/.test(compact)) {
    // A Greek number typed with the ISO code gets the VAT prefix (GR-R-003).
    return compact.startsWith("GR") ? `EL${compact.slice(2)}` : compact;
  }
  return `${country === "GR" ? "EL" : country}${compact}`;
}

export type EndpointId = { scheme: string; id: string };

// The party's Peppol address from its VAT number, or null when the country
// has no VAT-number scheme (or there is no VAT number).
export function endpointFromVat(
  vat: string | null | undefined,
  country: string | null | undefined,
): EndpointId | null {
  if (!vat?.trim() || !country) {
    return null;
  }
  const scheme = VAT_EAS_SCHEMES[country];
  if (!scheme) {
    return null;
  }
  return { scheme, id: normalizeVatId(vat, country) };
}
