import { describe, expect, it } from "vitest";

import {
  bicSchema,
  buyerReferenceSchema,
  formatIban,
  ibanSchema,
  isValidBic,
  isValidIban,
  normalizeBuyerReference,
  suggestedVatexCode,
  unitCodeSchema,
  vatexCodeSchema,
} from "./einvoice-codes";

describe("IBAN", () => {
  it("accepts real IBANs with or without spaces and in lower case", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("de89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
  });

  it("refuses a wrong checksum, bad shape or a too-short number", () => {
    expect(isValidIban("DE89370400440532013001")).toBe(false);
    expect(isValidIban("1234567890")).toBe(false);
    expect(isValidIban("DE8937")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });

  it("stores compact, upper case, and clears on empty", () => {
    expect(ibanSchema.parse(" de89 3704 0044 0532 0130 00 ")).toBe(
      "DE89370400440532013000",
    );
    expect(ibanSchema.parse("")).toBeNull();
    expect(ibanSchema.parse(null)).toBeNull();
    expect(ibanSchema.safeParse("DE00 1234").success).toBe(false);
  });

  it("prints in groups of four", () => {
    expect(formatIban("DE89370400440532013000")).toBe(
      "DE89 3704 0044 0532 0130 00",
    );
  });
});

describe("BIC", () => {
  it("accepts 8 and 11 characters", () => {
    expect(isValidBic("DEUTDEFF")).toBe(true);
    expect(isValidBic("cobadeffxxx")).toBe(true);
    expect(isValidBic("DEUTDEF")).toBe(false);
    expect(isValidBic("1234DEFF")).toBe(false);
  });

  it("stores upper case and clears on empty", () => {
    expect(bicSchema.parse("cobadeffxxx")).toBe("COBADEFFXXX");
    expect(bicSchema.parse("")).toBeNull();
    expect(bicSchema.safeParse("NOPE").success).toBe(false);
  });
});

describe("codes", () => {
  it("allows only the listed unit and VATEX codes", () => {
    expect(unitCodeSchema.parse("HUR")).toBe("HUR");
    expect(unitCodeSchema.safeParse("XYZ").success).toBe(false);
    expect(vatexCodeSchema.parse("VATEX-EU-AE")).toBe("VATEX-EU-AE");
    expect(vatexCodeSchema.safeParse("VATEX-XX").success).toBe(false);
  });

  it("suggests VATEX-EU-AE for reverse charge only", () => {
    expect(suggestedVatexCode("reverse_charge")).toBe("VATEX-EU-AE");
    expect(suggestedVatexCode("standard")).toBeNull();
    expect(suggestedVatexCode("zero_rated")).toBeNull();
  });
});

describe("buyer reference", () => {
  it("trims, clears on empty and caps the length", () => {
    expect(buyerReferenceSchema.parse("  PO-1 ")).toBe("PO-1");
    expect(buyerReferenceSchema.parse("")).toBeNull();
    expect(buyerReferenceSchema.parse(null)).toBeNull();
    expect(buyerReferenceSchema.safeParse("x".repeat(201)).success).toBe(false);
    expect(normalizeBuyerReference("  ")).toBeNull();
    expect(normalizeBuyerReference(" A ")).toBe("A");
    expect(normalizeBuyerReference(undefined)).toBeNull();
  });
});
