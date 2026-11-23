import { EAS_SCHEMES } from "./peppol-eas";

// Code lists and identifiers that e-invoices (EN 16931 / Peppol BIS 3.0)
// need and Clerq's own invoices print when set (#5039): the plain constants
// and checks, with no zod. Client components import from here, so the zod
// runtime stays out of their bundles (#5695); the schemas built on these are
// in einvoice-codes.ts, which re-exports everything below.

// UN/ECE Recommendation 20 unit codes (BT-130) a Clerq line can carry. Time
// is tracked in seconds and day rates become hourly rates at entry
// creation, so generated lines are always hours (HUR); the rest are for
// lines typed by hand.
export const UNIT_CODES = [
  { code: "HUR", label: "Hours" },
  { code: "DAY", label: "Days" },
  { code: "WEE", label: "Weeks" },
  { code: "MON", label: "Months" },
  { code: "ANN", label: "Years" },
  { code: "C62", label: "Units (fixed amount)" },
] as const;

export type UnitCode = (typeof UNIT_CODES)[number]["code"];

// Lines generated from time are hours; fixed amounts are one "unit".
export const TIME_LINE_UNIT: UnitCode = "HUR";
export const FIXED_LINE_UNIT: UnitCode = "C62";

// VATEX exemption reason codes (BT-121) for the treatments Clerq supports.
export const VATEX_CODES = [
  { code: "VATEX-EU-AE", label: "Reverse charge" },
  { code: "VATEX-EU-IC", label: "Intra-community supply" },
  { code: "VATEX-EU-G", label: "Export outside the EU" },
  { code: "VATEX-EU-O", label: "Not subject to VAT" },
  { code: "VATEX-EU-79-C", label: "Exempt (Article 79(c))" },
] as const;

export type VatexCode = (typeof VATEX_CODES)[number]["code"];

// The code the form suggests for a tax treatment, if any.
export function suggestedVatexCode(
  treatment: "standard" | "zero_rated" | "reverse_charge",
): VatexCode | null {
  return treatment === "reverse_charge" ? "VATEX-EU-AE" : null;
}

// Spaces and lower case are accepted on the way in, stored without.
export function compactIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

// ISO 13616: two letters, two check digits, up to 30 alphanumerics, and the
// mod-97 checksum of the rearranged number equals 1.
export function isValidIban(value: string): boolean {
  const iban = compactIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) {
      remainder = (remainder * 10 + Number(d)) % 97;
    }
  }
  return remainder === 1;
}

// ISO 9362: bank (4 letters), country (2 letters), location (2), optional
// branch (3).
export function isValidBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(
    value.replace(/\s+/g, "").toUpperCase(),
  );
}

// Groups of four, the way banks print it.
export function formatIban(value: string): string {
  return compactIban(value).replace(/(.{4})/g, "$1 ").trim();
}

// Trimmed, "" -> null: for service-layer callers that skip the schema.
export function normalizeBuyerReference(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// A Peppol ID (electronic address, EN 16931 BT-34 seller / BT-49 buyer) in
// the usual "scheme:value" form, e.g. "0184:12345678" (#5075). Optional on
// the business and on each client; when set, the e-invoice export uses it
// ahead of the address it would work out from the VAT number.
export type PeppolId = { scheme: string; id: string };

const EAS_CODES: ReadonlySet<string> = new Set(EAS_SCHEMES.map((s) => s.code));

export function isEasScheme(code: string): boolean {
  return EAS_CODES.has(code);
}

// Schemes that can identify a legal entity (BT-30): the ISO 6523 ICD codes
// in the EAS list, without the 99xx VAT-number schemes.
export const COMPANY_NUMBER_SCHEMES = EAS_SCHEMES.filter(
  (s) => !s.code.startsWith("99"),
);

export function isCompanyNumberScheme(code: string): boolean {
  return EAS_CODES.has(code) && !code.startsWith("99");
}

// "0184:12345678" -> its parts, or null when it isn't a Peppol ID with a
// known scheme. The value keeps its case; spaces around it are dropped.
export function parsePeppolId(value: string | null | undefined): PeppolId | null {
  const match = /^\s*(\d{4})\s*:\s*(\S(?:.*\S)?)\s*$/.exec(value ?? "");
  if (!match || !isEasScheme(match[1]) || match[2].length > 50) {
    return null;
  }
  // The value is an identifier, never free text.
  if (!/^[A-Za-z0-9:._~+\-]+$/.test(match[2])) {
    return null;
  }
  return { scheme: match[1], id: match[2] };
}

export function formatPeppolId(id: PeppolId): string {
  return `${id.scheme}:${id.id}`;
}

// For service-layer callers that skip the schema: the compact form, or
// null for anything that isn't a Peppol ID.
export function normalizePeppolId(value: string | null | undefined): string | null {
  const parsed = parsePeppolId(value);
  return parsed ? formatPeppolId(parsed) : null;
}

// The register a country's company numbers usually come from, where the
// Peppol rules name one: offered as the default in the forms.
export const COMPANY_NUMBER_SCHEME_BY_COUNTRY: Readonly<Record<string, string>> = {
  DK: "0184",
  IS: "0196",
  NL: "0106",
  NO: "0192",
  SE: "0007",
};
