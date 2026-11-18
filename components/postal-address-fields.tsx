"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  suggestPostalAddress,
  type AddressSuggestion,
  type CountryOption,
  type PostalAddress,
  type PostalAddressInput,
} from "@/lib/postal-address";

// Editable state of the structured address: plain strings, "" = not set.
export type PostalAddressDraft = {
  street: string;
  city: string;
  postcode: string;
  region: string;
  country: string;
};

export function postalAddressDraft(
  value: PostalAddress | null | undefined,
): PostalAddressDraft {
  return {
    street: value?.street ?? "",
    city: value?.city ?? "",
    postcode: value?.postcode ?? "",
    region: value?.region ?? "",
    country: value?.country ?? "",
  };
}

function isEmpty(draft: PostalAddressDraft): boolean {
  return Object.values(draft).every((part) => part.trim() === "");
}

// The value to send: null when nothing is filled in. A partly filled address
// without a country is an error the form shows (EN 16931 needs the country).
export function postalAddressFromDraft(
  draft: PostalAddressDraft,
): { value: PostalAddressInput | null } | { error: string } {
  if (isEmpty(draft)) return { value: null };
  if (!draft.country) {
    return { error: "Pick a country for the structured address" };
  }
  return {
    value: {
      street: draft.street.trim() || null,
      city: draft.city.trim() || null,
      postcode: draft.postcode.trim() || null,
      region: draft.region.trim() || null,
      country: draft.country,
    },
  };
}

function describe(
  suggestion: AddressSuggestion,
  countryOptions: CountryOption[],
): string {
  const country = suggestion.country
    ? (countryOptions.find((o) => o.code === suggestion.country)?.label ??
      suggestion.country)
    : null;
  return [
    suggestion.street?.replace(/\n/g, ", "),
    [suggestion.postcode, suggestion.city].filter(Boolean).join(" "),
    suggestion.region,
    country,
  ]
    .filter(Boolean)
    .join(" · ");
}

const fieldClass =
  "rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

// Street / city / postcode / region / country, shown under the free-text
// address. While every part is empty and the free text can be split, it
// offers that split ("Use this"); nothing is filled in or saved until the
// user takes it and saves the form.
export function PostalAddressFields({
  value,
  onChange,
  freeText,
  countryOptions,
  error,
}: {
  value: PostalAddressDraft;
  onChange: (value: PostalAddressDraft) => void;
  // The free-text address the suggestion is made from.
  freeText: string;
  countryOptions: CountryOption[];
  error?: string | null;
}) {
  const suggestion = isEmpty(value)
    ? suggestPostalAddress(freeText, countryOptions)
    : null;

  function set(part: keyof PostalAddressDraft, next: string) {
    onChange({ ...value, [part]: next });
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-medium">Address for e-invoices</legend>
      <p className="text-xs text-muted-foreground">
        The same address in parts, used for electronic invoices (EN 16931).
        Invoice PDFs still print the address above.
      </p>

      {suggestion ? (
        <div
          data-testid="address-suggestion"
          className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p>
            <span className="text-muted-foreground">Suggested from the address above: </span>
            {describe(suggestion, countryOptions)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() =>
              onChange({
                street: suggestion.street ?? "",
                city: suggestion.city ?? "",
                postcode: suggestion.postcode ?? "",
                region: suggestion.region ?? "",
                country: suggestion.country ?? "",
              })
            }
          >
            Use this
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="postal-street">Street</Label>
        <textarea
          id="postal-street"
          rows={2}
          placeholder="12 Harbour Street"
          value={value.street}
          onChange={(e) => set("street", e.target.value)}
          className={fieldClass}
        />
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="postal-city">City</Label>
          <Input
            id="postal-city"
            placeholder="Bristol"
            value={value.city}
            onChange={(e) => set("city", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2 sm:w-36">
          <Label htmlFor="postal-postcode">Postcode</Label>
          <Input
            id="postal-postcode"
            placeholder="BS1 4QA"
            value={value.postcode}
            onChange={(e) => set("postcode", e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="postal-region">Region (optional)</Label>
          <Input
            id="postal-region"
            placeholder="State, county or province"
            value={value.region}
            onChange={(e) => set("region", e.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="postal-country">Country</Label>
          <select
            id="postal-country"
            value={value.country}
            onChange={(e) => set("country", e.target.value)}
            className="h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <option value="">Not set</option>
            {countryOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}
