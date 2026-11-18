// Countries of the European Economic Area: the 27 EU member states plus
// Iceland, Liechtenstein and Norway. E-invoicing (EN 16931 / Peppol) is only
// offered to businesses established here: the mandates in
// docs/spikes/eu-einvoicing.md apply to the seller's country, and the UK has
// none. ISO 3166-1 alpha-2; Greece is "GR" (not the EU's own "EL").
export const EEA_COUNTRY_CODES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
  "IS", "LI", "NO",
] as const;

const EEA_SET: ReadonlySet<string> = new Set(EEA_COUNTRY_CODES);

export function isEeaCountry(code: string | null | undefined): boolean {
  return code != null && EEA_SET.has(code.trim().toUpperCase());
}

export const EINVOICING_EEA_ONLY_MESSAGE =
  "E-invoicing is only for businesses established in the EEA (EU, Iceland, Liechtenstein, Norway): pick an EEA country for the business address";
