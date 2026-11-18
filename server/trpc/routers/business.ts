import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "@/db";
import {
  normalizePostalAddress,
  postalAddressSchema,
} from "@/lib/postal-address";
import { EINVOICING_EEA_ONLY_MESSAGE, isEeaCountry } from "@/lib/eea";
import { bicSchema, ibanSchema } from "@/lib/einvoice-codes";
import { getUserBusinesses, setActiveBusiness } from "@/server/membership";
import {
  authedProcedure,
  businessProcedure,
  createTRPCRouter,
  permissionProcedure,
} from "../init";

// Shape of the branding JSONB blob. Owned here: the logo is a base64 data
// URL (no blob store to run when self-hosting), the brand colour an #rrggbb
// hex, and the footer a short line printed at the foot of every invoice.
type Branding = {
  logoDataUrl?: string;
  brandColor?: string;
  footerNote?: string;
};

// A PNG/JPEG data URL, capped so an oversized image can't bloat the row or
// the invoice PDF. ~1.5MB of base64 is roughly a 1MB source image.
const logoDataUrlSchema = z
  .string()
  .trim()
  .regex(
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/,
    "Upload a PNG or JPEG image",
  )
  .max(1_500_000, "Logo image is too large - keep it under ~1MB")
  .nullable();

export const businessRouter = createTRPCRouter({
  // Onboarding: the signed-up user creates their business and becomes its
  // owner in one transaction. Currency is stored as an ISO 4217 code only -
  // no interpretation happens outside the billing module.
  create: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/, "Use a three-letter currency code like EUR"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.business)
          .values({ name: input.name, currency: input.currency })
          .returning();
        await tx.insert(schema.businessMember).values({
          businessId: created.id,
          userId: ctx.session.user.id,
          role: "owner",
        });
        // Switch to the business just created: making a new one and then
        // having to hunt for it in the switcher would be a surprise. The
        // pointer is upserted so this also covers the user's very first
        // business (onboarding) and any later one.
        await tx
          .insert(schema.userActiveBusiness)
          .values({ userId: ctx.session.user.id, businessId: created.id })
          .onConflictDoUpdate({
            target: schema.userActiveBusiness.userId,
            set: { businessId: created.id, updatedAt: new Date() },
          });
        return created;
      });
    }),

  // Every business the signed-in user can act in, for the switcher, with the
  // active one flagged. Sits behind businessProcedure: only a user who already
  // belongs to a business reaches the switcher, and this never leaks businesses
  // the user is not a member of.
  list: businessProcedure.query(async ({ ctx }) => {
    return getUserBusinesses(ctx.session.user.id);
  }),

  // Make `businessId` the user's active business. Guarded by membership in
  // setActiveBusiness, so a forged id for a business the user is not part of is
  // rejected rather than silently switched to.
  switch: authedProcedure
    .input(z.object({ businessId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await setActiveBusiness(ctx.session.user.id, input.businessId);
      if (!ok) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of that business",
        });
      }
      return { businessId: input.businessId };
    }),

  current: businessProcedure.query(async ({ ctx }) => {
    const [row] = await getDb()
      .select({
        id: schema.business.id,
        name: schema.business.name,
        currency: schema.business.currency,
        // Any member may read it: it decides whether forms (clients,
        // invoices) show e-invoicing fields.
        einvoicingEnabled: schema.business.einvoicingEnabled,
      })
      .from(schema.business)
      .where(eq(schema.business.id, ctx.businessId));
    return row;
  }),

  settings: permissionProcedure("settings.view").query(async ({ ctx }) => {
    const [row] = await getDb()
      .select({
        name: schema.business.name,
        address: schema.business.address,
        postalAddress: schema.business.postalAddress,
        einvoicingEnabled: schema.business.einvoicingEnabled,
        iban: schema.business.iban,
        bic: schema.business.bic,
        currency: schema.business.currency,
        hoursPerDay: schema.business.hoursPerDay,
        taxConfig: schema.business.taxConfig,
        branding: schema.business.branding,
      })
      .from(schema.business)
      .where(eq(schema.business.id, ctx.businessId));
    const taxConfig = (row?.taxConfig ?? {}) as {
      standardRatePct?: string;
      vatNumber?: string;
    };
    const branding = (row?.branding ?? {}) as Branding;
    return {
      name: row.name,
      address: row.address,
      postalAddress: row.postalAddress ?? null,
      einvoicingEnabled: row.einvoicingEnabled,
      iban: row.iban,
      bic: row.bic,
      currency: row.currency,
      hoursPerDay: row.hoursPerDay,
      standardRatePct: taxConfig.standardRatePct ?? null,
      vatNumber: taxConfig.vatNumber ?? null,
      logoDataUrl: branding.logoDataUrl ?? null,
      brandColor: branding.brandColor ?? null,
      footerNote: branding.footerNote ?? null,
    };
  }),

  updateSettings: permissionProcedure("settings.edit")
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/, "Use a three-letter currency code like EUR"),
        // Working hours per billing day - the day-rate divisor (1..24).
        hoursPerDay: z.number().int().min(1).max(24).default(8),
        // Stored verbatim into tax_config; the tax engine consumes it as
        // a decimal string (spec Section 4) and never defaults it.
        standardRatePct: z
          .string()
          .trim()
          .regex(/^\d+(\.\d+)?$/, "Use a plain number like 21 or 12.5")
          .nullable(),
        vatNumber: z.string().trim().max(30).nullable(),
        address: z.string().trim().max(500).nullable(),
        // Structured copy for e-invoices. Left out = keep; null clears it.
        postalAddress: postalAddressSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // While e-invoicing is on, the business address must stay in the EEA.
      if (input.postalAddress !== undefined) {
        const [current] = await getDb()
          .select({ einvoicingEnabled: schema.business.einvoicingEnabled })
          .from(schema.business)
          .where(eq(schema.business.id, ctx.businessId));
        if (
          current?.einvoicingEnabled &&
          !isEeaCountry(normalizePostalAddress(input.postalAddress)?.country)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: EINVOICING_EEA_ONLY_MESSAGE,
          });
        }
      }
      const [updated] = await getDb()
        .update(schema.business)
        .set({
          name: input.name,
          address: input.address,
          ...(input.postalAddress !== undefined
            ? { postalAddress: normalizePostalAddress(input.postalAddress) }
            : {}),
          currency: input.currency,
          hoursPerDay: input.hoursPerDay,
          taxConfig: {
            ...(input.standardRatePct
              ? { standardRatePct: input.standardRatePct }
              : {}),
            ...(input.vatNumber ? { vatNumber: input.vatNumber } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.business.id, ctx.businessId))
        .returning();
      return updated;
    }),

  // The e-invoicing opt-in (#5065) and the business's structured address,
  // saved together from Settings -> E-invoicing. Turning it on needs an EEA
  // address (the one given here, or the one already saved). Turning it off
  // keeps the saved address, so turning it back on brings it back.
  updateEinvoicing: permissionProcedure("settings.edit")
    .input(
      z.object({
        enabled: z.boolean(),
        // Left out = keep; ignored while turning it off.
        postalAddress: postalAddressSchema.optional(),
        // Bank details for payment instructions (#5039). Left out = keep,
        // null or "" clears; ignored while turning it off.
        iban: ibanSchema.optional(),
        bic: bicSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (!input.enabled) {
        const [updated] = await db
          .update(schema.business)
          .set({ einvoicingEnabled: false, updatedAt: new Date() })
          .where(eq(schema.business.id, ctx.businessId))
          .returning({
            einvoicingEnabled: schema.business.einvoicingEnabled,
            postalAddress: schema.business.postalAddress,
            iban: schema.business.iban,
            bic: schema.business.bic,
          });
        return updated;
      }
      const [current] = await db
        .select({ postalAddress: schema.business.postalAddress })
        .from(schema.business)
        .where(eq(schema.business.id, ctx.businessId));
      const postalAddress =
        input.postalAddress !== undefined
          ? normalizePostalAddress(input.postalAddress)
          : (current?.postalAddress ?? null);
      if (!isEeaCountry(postalAddress?.country)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: EINVOICING_EEA_ONLY_MESSAGE,
        });
      }
      const [updated] = await db
        .update(schema.business)
        .set({
          einvoicingEnabled: true,
          postalAddress,
          ...(input.iban !== undefined ? { iban: input.iban } : {}),
          ...(input.bic !== undefined ? { bic: input.bic } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.business.id, ctx.businessId))
        .returning({
          einvoicingEnabled: schema.business.einvoicingEnabled,
          postalAddress: schema.business.postalAddress,
          iban: schema.business.iban,
          bic: schema.business.bic,
        });
      return updated;
    }),

  // Logo, brand colour and a short footer line for the invoice. Kept separate
  // from updateSettings so the (potentially large) logo only travels when the
  // appearance is actually changed. Owner-only, like the rest of settings.
  updateBranding: permissionProcedure("branding.edit")
    .input(
      z.object({
        logoDataUrl: logoDataUrlSchema,
        brandColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour like #228E80")
          .nullable(),
        footerNote: z.string().trim().max(2000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Read-modify-write so unknown keys the design system may add later
      // survive an appearance edit. Absent values drop the key entirely.
      const [current] = await getDb()
        .select({ branding: schema.business.branding })
        .from(schema.business)
        .where(eq(schema.business.id, ctx.businessId));
      const branding: Branding = { ...((current?.branding ?? {}) as Branding) };
      if (input.logoDataUrl) branding.logoDataUrl = input.logoDataUrl;
      else delete branding.logoDataUrl;
      if (input.brandColor) branding.brandColor = input.brandColor;
      else delete branding.brandColor;
      if (input.footerNote) branding.footerNote = input.footerNote;
      else delete branding.footerNote;

      const [updated] = await getDb()
        .update(schema.business)
        .set({ branding, updatedAt: new Date() })
        .where(eq(schema.business.id, ctx.businessId))
        .returning();
      return updated;
    }),
});
