import { z } from "zod";

import {
  compactIban,
  formatPeppolId,
  isCompanyNumberScheme,
  isValidBic,
  isValidIban,
  parsePeppolId,
  UNIT_CODES,
  VATEX_CODES,
  type UnitCode,
  type VatexCode,
} from "./einvoice-codes-shared";

// Code lists and identifiers that e-invoices (EN 16931 / Peppol BIS 3.0)
// need and Clerq's own invoices print when set (#5039). Shared by the
// forms, the routers, the REST API and MCP. The zod schemas live here; the
// constants and checks they build on are in einvoice-codes-shared.ts
// (re-exported below), which is what client components import, so zod
// stays out of the browser bundle (#5695).
export * from "./einvoice-codes-shared";

export const unitCodeSchema = z.enum(
  UNIT_CODES.map((u) => u.code) as [UnitCode, ...UnitCode[]],
  { message: "Pick a unit code from the list (HUR, DAY, WEE, MON, ANN, C62)" },
);

export const vatexCodeSchema = z.enum(
  VATEX_CODES.map((v) => v.code) as [VatexCode, ...VatexCode[]],
  { message: "Pick a VATEX code from the list" },
);

// Buyer reference / PO number (BT-10). Free text; Peppol allows up to 200.
// An empty string clears it.
export const buyerReferenceSchema = z
  .string()
  .trim()
  .max(200, "Keep the buyer reference under 200 characters")
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const ibanSchema = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : compactIban(v)))
  .nullable()
  .refine((v) => v === null || isValidIban(v), {
    message: "That IBAN doesn't look right - check the number",
  });

export const bicSchema = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v.replace(/\s+/g, "").toUpperCase()))
  .nullable()
  .refine((v) => v === null || isValidBic(v), {
    message: "A BIC is 8 or 11 letters and digits, like DEUTDEFF",
  });

// Seller contact for e-invoices (BG-6). Empty parts become null; a contact
// with nothing in it is stored as null.
export const einvoiceContactSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    phone: z
      .string()
      .trim()
      .max(50)
      .refine((v) => v === "" || /\d{3,}/.test(v.replace(/\D/g, "")), {
        message: "A phone number needs at least 3 digits",
      })
      .nullable()
      .optional(),
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === "" || z.string().email().safeParse(v).success, {
        message: "That email address doesn't look right",
      })
      .nullable()
      .optional(),
  })
  .transform((c) => {
    const out = {
      name: c.name || null,
      phone: c.phone || null,
      email: c.email || null,
    };
    return out.name || out.phone || out.email ? out : null;
  })
  .nullable();

// "" / null clear it; anything else must parse.
export const peppolIdSchema = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || parsePeppolId(v) !== null, {
    message:
      "A Peppol ID is a 4-digit scheme from the Peppol list, a colon and the number, like 0184:12345678",
  })
  .transform((v) => {
    const parsed = parsePeppolId(v);
    return parsed ? formatPeppolId(parsed) : null;
  });

// The business's company registration number (BT-30) and, optionally, the
// register it comes from.
export const companyNumberSchema = z
  .string()
  .trim()
  .max(50, "Keep the company number under 50 characters")
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const companyNumberSchemeSchema = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || isCompanyNumberScheme(v), {
    message: "Pick the company register from the list",
  });
