// Peppol electronic addresses (EN 16931 BT-34 seller / BT-49 buyer) are
// "<EAS scheme>:<id>". Unless a Peppol ID was typed in (#5075), the export
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

// Company registration numbers (EN 16931 BT-30 / BT-47) --------------------

export type CompanyId = { id: string; scheme: string | null };

// Registers whose numbers are plain digits: written without spaces, dots
// or dashes ("556677-8899" -> "5566778899").
const DIGIT_SCHEMES = new Set(["0007", "0106", "0184", "0190", "0192", "0196"]);

function compactNumber(value: string): string {
  return value.replace(/[\s.\-]/g, "").toUpperCase();
}

// The seller's company number as stored (number + the register picked in
// Settings).
export function companyIdOf(
  number: string | null | undefined,
  scheme: string | null | undefined,
): CompanyId | null {
  const trimmed = number?.trim();
  if (!trimmed) {
    return null;
  }
  if (scheme && DIGIT_SCHEMES.has(scheme)) {
    return { id: compactNumber(trimmed), scheme };
  }
  return { id: trimmed, scheme: scheme || null };
}

// Register and number shape per country, where the Peppol rules name the
// register (NL-R-005, DK-R-017, IS-R-004) or Peppol addresses go by it.
const CLIENT_REGISTERS: Readonly<Record<string, [RegExp, string][]>> = {
  NL: [
    [/^\d{8}$/, "0106"],
    [/^\d{20}$/, "0190"],
  ],
  DK: [[/^\d{8}$/, "0184"]],
  SE: [[/^\d{10}$/, "0007"]],
  NO: [[/^\d{9}$/, "0192"]],
  IS: [[/^\d{10}$/, "0196"]],
};

// Clients have a company number but no register. When the number has the
// shape of the country's register, the export adds the register; otherwise
// the number goes out as typed, without one.
export function clientCompanyId(
  number: string | null | undefined,
  country: string | null | undefined,
): CompanyId | null {
  const trimmed = number?.trim();
  if (!trimmed) {
    return null;
  }
  let compact = compactNumber(trimmed);
  if (country && compact.startsWith(country)) {
    compact = compact.slice(2);
  }
  const match = (CLIENT_REGISTERS[country ?? ""] ?? []).find(([shape]) =>
    shape.test(compact),
  );
  return match ? { id: compact, scheme: match[1] } : { id: trimmed, scheme: null };
}

// Countries whose Peppol addresses go by the company register number
// (CVR, organisationsnummer, organisasjonsnummer, kennitala): a company
// number from that register doubles as the Peppol ID when none is given.
const REGISTER_EAS_SCHEMES: Readonly<Record<string, string>> = {
  DK: "0184",
  IS: "0196",
  NO: "0192",
  SE: "0007",
};

export function endpointFromCompanyId(
  company: CompanyId | null,
  country: string | null | undefined,
): EndpointId | null {
  if (!company?.scheme || !country) {
    return null;
  }
  return REGISTER_EAS_SCHEMES[country] === company.scheme
    ? { scheme: company.scheme, id: company.id }
    : null;
}

// Swedish organisation numbers end in a Luhn check digit (Peppol SE-R-013).
export function isValidSwedishOrgNumber(value: string): boolean {
  if (!/^\d{10}$/.test(value)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = Number(value[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Norwegian organisation numbers end in a mod-11 check digit
// (PEPPOL-COMMON-R041).
export function isValidNorwegianOrgNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) {
    return false;
  }
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(value[i]), 0);
  const check = (11 - (sum % 11)) % 11;
  return check !== 10 && check === Number(value[8]);
}

// The shapes the Peppol validators insist on for a register's numbers
// (PEPPOL-COMMON-R041/R042/R049 fatal, R054/R055 warnings). Other schemes
// aren't checked.
export function isWellFormedRegisterNumber(scheme: string, id: string): boolean {
  switch (scheme) {
    case "0007":
      return isValidSwedishOrgNumber(id);
    case "0106":
      return /^\d{8}$/.test(id);
    case "0184":
      return /^(DK)?\d{8}$/.test(id);
    case "0190":
      return /^\d{20}$/.test(id);
    case "0192":
      return isValidNorwegianOrgNumber(id);
    default:
      return true;
  }
}

export const REGISTER_NAMES: Readonly<Record<string, string>> = {
  "0007": "Swedish organisationsnummer (10 digits)",
  "0106": "KVK number (8 digits)",
  "0184": "CVR number (8 digits)",
  "0190": "OIN (20 digits)",
  "0192": "Norwegian organisation number (9 digits)",
};
