import { z } from "zod";

import { isCountryCode, type PostalAddress } from "./postal-address-shared";

// Structured postal address for e-invoicing (EN 16931 BG-5 seller / BG-8
// buyer postal address). Kept next to the free-text `address` column on the
// business and client: the free text is still what the PDF prints, this is
// what an e-invoice will carry. Every part is optional except the country
// (BT-40 / BT-55 are mandatory in EN 16931 once an address exists).
// The zod-free parts (country list, stored shape, the free-text suggestion)
// are in postal-address-shared.ts and re-exported here (#5695).
export * from "./postal-address-shared";

// UBL allows a street line, an additional street line and one more address
// line, so the street part is capped at three lines.
const MAX_STREET_LINES = 3;

const optionalPart = (max: number) =>
  z.string().trim().max(max).nullable().optional();

export const postalAddressSchema = z.object({
  // Street and house number; up to three lines, newline-separated.
  street: optionalPart(500).refine(
    (value) => !value || value.split(/\r?\n/).length <= MAX_STREET_LINES,
    `Use at most ${MAX_STREET_LINES} street lines`,
  ),
  city: optionalPart(200),
  postcode: optionalPart(32),
  // State, county or province, when the country uses one.
  region: optionalPart(200),
  // ISO 3166-1 alpha-2 country code, e.g. GB, DE, FR.
  country: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isCountryCode, "Pick a country (ISO 3166-1 code like GB or DE)"),
});

export type PostalAddressInput = z.infer<typeof postalAddressSchema>;

function part(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Turns validated input into the stored shape. `null` stays null (cleared);
// `undefined` stays undefined (the caller keeps the stored value).
export function normalizePostalAddress(
  input: PostalAddressInput | null | undefined,
): PostalAddress | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  return {
    street: part(input.street)
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n") ?? null,
    city: part(input.city),
    postcode: part(input.postcode),
    region: part(input.region),
    country: input.country.trim().toUpperCase(),
  };
}
