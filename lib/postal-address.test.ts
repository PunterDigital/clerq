import { describe, expect, it, vi } from "vitest";

import {
  COUNTRY_CODES,
  normalizePostalAddress,
  postalAddressSchema,
  suggestPostalAddress,
} from "./postal-address";

// `server-only` throws outside an RSC build; the country list is plain data.
vi.mock("server-only", () => ({}));
const { listCountryOptions } = await import("./countries");

const options = listCountryOptions();
const suggest = (text: string) => suggestPostalAddress(text, options);

describe("country list", () => {
  it("has every officially assigned ISO 3166-1 alpha-2 code once", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
  });

  it("labels codes in English, sorted by name", () => {
    expect(options.find((o) => o.code === "DE")?.label).toBe("Germany");
    const labels = options.map((o) => o.label);
    expect(labels).toEqual(
      [...labels].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
});

describe("suggestPostalAddress", () => {
  it("splits a UK address with the postcode on the town line", () => {
    expect(suggest("12 Harbour Street\nBristol BS1 4QA\nUnited Kingdom")).toEqual({
      street: "12 Harbour Street",
      city: "Bristol",
      postcode: "BS1 4QA",
      region: null,
      country: "GB",
    });
  });

  it("takes the town from the line above a UK postcode on its own line", () => {
    expect(suggest("Flat 3\n10 Downing Street\nLondon\nsw1a2aa")).toEqual({
      street: "Flat 3\n10 Downing Street",
      city: "London",
      postcode: "SW1A 2AA",
      region: null,
      country: "GB",
    });
  });

  it("reads a German address with a named country", () => {
    expect(suggest("Hauptstraße 5\n10115 Berlin\nDeutschland")).toEqual({
      street: "Hauptstraße 5",
      city: "Berlin",
      postcode: "10115",
      region: null,
      country: "DE",
    });
  });

  it("leaves the country out when a five-digit postcode could be anywhere", () => {
    expect(suggest("8 Rue de Rivoli\n75001 Paris")).toEqual({
      street: "8 Rue de Rivoli",
      city: "Paris",
      postcode: "75001",
      region: null,
      country: null,
    });
  });

  it("uses an old country prefix on the postcode", () => {
    expect(suggest("Ringstraße 1\nA-1010 Wien")?.country).toBe("AT");
  });

  it("recognises Dutch postcodes", () => {
    expect(suggest("Damrak 1\n1012 LG Amsterdam")).toEqual({
      street: "Damrak 1",
      city: "Amsterdam",
      postcode: "1012 LG",
      region: null,
      country: "NL",
    });
  });

  it("reads a US city, state and ZIP line", () => {
    expect(suggest("500 Congress Ave\nAustin, TX 78701\nUSA")).toEqual({
      street: "500 Congress Ave",
      city: "Austin",
      postcode: "78701",
      region: "TX",
      country: "US",
    });
  });

  it("splits a single comma-separated line", () => {
    expect(suggest("Długa 4, 00-950 Warszawa, Polska")).toEqual({
      street: "Długa 4",
      city: "Warszawa",
      postcode: "00-950",
      region: null,
      country: "PL",
    });
  });

  it("reads an Irish Eircode", () => {
    expect(suggest("1 Grafton Street\nDublin 2 D02 X285\nIreland")).toEqual({
      street: "1 Grafton Street",
      city: "Dublin 2",
      postcode: "D02 X285",
      region: null,
      country: "IE",
    });
  });

  it("keeps a Czech postcode without guessing between CZ and SK", () => {
    const result = suggest("Vodičkova 30\n110 00 Praha 1\nCzechia");
    expect(result).toEqual({
      street: "Vodičkova 30",
      city: "Praha 1",
      postcode: "110 00",
      region: null,
      country: "CZ",
    });
  });

  it("falls back to street + town when there is no postcode", () => {
    expect(suggest("Main Road\nSmallville")).toEqual({
      street: "Main Road",
      city: "Smallville",
      postcode: null,
      region: null,
      country: null,
    });
  });

  it("returns null for an empty address", () => {
    expect(suggest("  \n ")).toBeNull();
    expect(suggestPostalAddress(null, options)).toBeNull();
  });
});

describe("postalAddressSchema", () => {
  it("requires a known country code", () => {
    expect(postalAddressSchema.safeParse({ country: "XX" }).success).toBe(false);
    expect(postalAddressSchema.safeParse({ city: "Bristol" }).success).toBe(false);
    expect(postalAddressSchema.parse({ country: "gb" }).country).toBe("GB");
  });

  it("refuses more than three street lines", () => {
    const result = postalAddressSchema.safeParse({
      street: "a\nb\nc\nd",
      country: "GB",
    });
    expect(result.success).toBe(false);
  });

  it("normalises empty parts to null and keeps undefined as 'leave alone'", () => {
    expect(
      normalizePostalAddress({
        street: " 1 High St \n\n Unit 2 ",
        city: " ",
        postcode: "BS1 4QA",
        country: "gb",
      }),
    ).toEqual({
      street: "1 High St\nUnit 2",
      city: null,
      postcode: "BS1 4QA",
      region: null,
      country: "GB",
    });
    expect(normalizePostalAddress(undefined)).toBeUndefined();
    expect(normalizePostalAddress(null)).toBeNull();
  });
});
