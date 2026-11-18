import { describe, expect, it } from "vitest";

import { COUNTRY_CODES } from "./postal-address";
import { EEA_COUNTRY_CODES, isEeaCountry } from "./eea";

describe("isEeaCountry", () => {
  it("covers the EU 27 plus Iceland, Liechtenstein and Norway", () => {
    expect(EEA_COUNTRY_CODES).toHaveLength(30);
    for (const code of ["DE", "FR", "BE", "IE", "GR", "NO", "IS", "LI"]) {
      expect(isEeaCountry(code)).toBe(true);
    }
  });

  it("leaves out the UK, Switzerland and the rest of the world", () => {
    for (const code of ["GB", "CH", "US", "EL", "XX"]) {
      expect(isEeaCountry(code)).toBe(false);
    }
  });

  it("ignores case and treats a missing country as outside", () => {
    expect(isEeaCountry("de")).toBe(true);
    expect(isEeaCountry(null)).toBe(false);
    expect(isEeaCountry(undefined)).toBe(false);
    expect(isEeaCountry("")).toBe(false);
  });

  it("only lists codes the address picker offers", () => {
    const known = new Set<string>(COUNTRY_CODES);
    expect(EEA_COUNTRY_CODES.filter((code) => !known.has(code))).toEqual([]);
  });
});
