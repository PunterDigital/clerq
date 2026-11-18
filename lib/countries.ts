import "server-only";

import { COUNTRY_CODES, type CountryOption } from "@/lib/postal-address";

// Country dropdown options, labelled in English and sorted by name. Built on
// the server and passed to client components as a prop, for the same reason
// as listCurrencyOptions: Node and browser ICU can disagree on display names,
// and computing the list on both sides would trip a hydration mismatch.
export function listCountryOptions(): CountryOption[] {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  return COUNTRY_CODES.map((code) => ({
    code,
    label: names.of(code) ?? code,
  })).sort((a, b) => a.label.localeCompare(b.label, "en"));
}
