import { and, asc, desc, eq, ilike, isNull } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";
import {
  normalizePostalAddress,
  postalAddressSchema,
} from "@/lib/postal-address";
import {
  buyerReferenceSchema,
  normalizeBuyerReference,
} from "@/lib/einvoice-codes";
import { likeContains } from "@/lib/search";

// Every function takes the caller's businessId and applies it to every
// query. Nothing in this module trusts a client id alone - a client id
// from another business behaves exactly like a missing record.

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().optional(),
  role: z.string().trim().max(100).optional(),
});

// Shared rate-shape helpers: an optional ISO 4217 code and the hour/day unit.
const rateCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/)
  .nullable()
  .optional();

// Optional on the wire; callers that omit it get "hour" applied in the
// service. Kept optional (not .default) so it stays optional in the inferred
// input type and existing object-literal callers don't have to pass it.
const rateUnitSchema = z.enum(["hour", "day"]).optional();

export const clientInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contacts: z.array(contactSchema).max(50).default([]),
  notes: z.string().trim().max(10_000).optional(),
  // Postal address, newline-separated, printed on invoices. Stored verbatim.
  address: z.string().trim().max(1_000).nullable().optional(),
  // The same address in parts, for e-invoices. Left out on update = keep the
  // stored one (older callers don't know the field); null clears it.
  postalAddress: postalAddressSchema.nullable().optional(),
  // Default buyer reference / PO number, copied onto each new invoice.
  // Left out on update = keep; null or "" clears it.
  buyerReference: buyerReferenceSchema.optional(),
  // Company / registration number (Companies House, IČO, etc.).
  companyNumber: z.string().trim().max(50).nullable().optional(),
  // Stored verbatim; validated only for shape. Required at issue time for
  // reverse-charge invoices (spec Section 4).
  vatNumber: z.string().trim().max(30).nullable().optional(),
  // Default rate, minor units + ISO 4217 code. Data only - the time module
  // resolves it, the billing module interprets it. The unit marks whether the
  // amount is per hour or per day (a day rate is divided by the business
  // hoursPerDay into an effective hourly rate at entry creation).
  defaultRateMinor: z.number().int().nonnegative().nullable().optional(),
  defaultRateCurrency: rateCurrencySchema,
  defaultRateUnit: rateUnitSchema,
  // Optional overall budget for the engagement (minor units + currency).
  budgetMinor: z.number().int().nonnegative().nullable().optional(),
  budgetCurrency: rateCurrencySchema,
});

export type ClientInput = z.infer<typeof clientInputSchema>;

// One member's pricing on a client: a required bill rate (hour or day) plus an
// optional internal cost and budget. The currency/unit shapes mirror the
// client default. internalCost* is margin-sensitive - the router only accepts
// and returns it for callers with reports.viewProfit.
export const memberRateInputSchema = z.object({
  userId: z.string().min(1),
  billRateMinor: z.number().int().nonnegative(),
  billRateCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  billRateUnit: rateUnitSchema,
  internalCostMinor: z.number().int().nonnegative().nullable().optional(),
  internalCostCurrency: rateCurrencySchema,
  internalCostUnit: rateUnitSchema,
  budgetMinor: z.number().int().nonnegative().nullable().optional(),
  budgetCurrency: rateCurrencySchema,
});

export type MemberRateInput = z.infer<typeof memberRateInputSchema>;

export async function listClients(
  db: Db,
  businessId: string,
  opts: { includeArchived?: boolean; search?: string } = {},
) {
  const filters = [eq(schema.client.businessId, businessId)];
  if (!opts.includeArchived) {
    filters.push(isNull(schema.client.archivedAt));
  }
  // Case-insensitive contains match on the client name.
  const term = opts.search?.trim();
  if (term) {
    filters.push(ilike(schema.client.name, likeContains(term)));
  }
  return db
    .select()
    .from(schema.client)
    .where(and(...filters))
    .orderBy(desc(schema.client.createdAt));
}

export async function getClient(db: Db, businessId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(schema.client)
    .where(
      and(
        eq(schema.client.businessId, businessId),
        eq(schema.client.id, clientId),
      ),
    );
  return row ?? null;
}

export async function createClient(
  db: Db,
  businessId: string,
  userId: string,
  input: ClientInput,
) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.client)
      .values({
        businessId,
        name: input.name,
        contacts: input.contacts,
        notes: input.notes ?? null,
        address: input.address || null,
        postalAddress: normalizePostalAddress(input.postalAddress) ?? null,
        buyerReference: normalizeBuyerReference(input.buyerReference),
        companyNumber: input.companyNumber || null,
        vatNumber: input.vatNumber || null,
        defaultRateMinor: input.defaultRateMinor ?? null,
        defaultRateCurrency: input.defaultRateCurrency ?? null,
        defaultRateUnit: input.defaultRateUnit ?? "hour",
        budgetMinor: input.budgetMinor ?? null,
        budgetCurrency: input.budgetCurrency ?? null,
      })
      .returning();
    await tx.insert(schema.activity).values({
      businessId,
      clientId: created.id,
      userId,
      type: "client_created",
      payload: { name: created.name },
    });
    return created;
  });
}

export async function updateClient(
  db: Db,
  businessId: string,
  userId: string,
  clientId: string,
  input: ClientInput,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.client)
      .set({
        name: input.name,
        contacts: input.contacts,
        notes: input.notes ?? null,
        address: input.address || null,
        // Only touched when the caller sent it (undefined = keep).
        ...(input.postalAddress !== undefined
          ? { postalAddress: normalizePostalAddress(input.postalAddress) }
          : {}),
        ...(input.buyerReference !== undefined
          ? { buyerReference: normalizeBuyerReference(input.buyerReference) }
          : {}),
        companyNumber: input.companyNumber || null,
        vatNumber: input.vatNumber || null,
        defaultRateMinor: input.defaultRateMinor ?? null,
        defaultRateCurrency: input.defaultRateCurrency ?? null,
        defaultRateUnit: input.defaultRateUnit ?? "hour",
        budgetMinor: input.budgetMinor ?? null,
        budgetCurrency: input.budgetCurrency ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.client.businessId, businessId),
          eq(schema.client.id, clientId),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    await tx.insert(schema.activity).values({
      businessId,
      clientId: updated.id,
      userId,
      type: "client_updated",
      payload: { name: updated.name },
    });
    return updated;
  });
}

async function setArchived(
  db: Db,
  businessId: string,
  userId: string,
  clientId: string,
  archived: boolean,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.client)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.client.businessId, businessId),
          eq(schema.client.id, clientId),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    await tx.insert(schema.activity).values({
      businessId,
      clientId: updated.id,
      userId,
      type: archived ? "client_archived" : "client_unarchived",
      payload: {},
    });
    return updated;
  });
}

export async function archiveClient(
  db: Db,
  businessId: string,
  userId: string,
  clientId: string,
) {
  return setArchived(db, businessId, userId, clientId, true);
}

export async function unarchiveClient(
  db: Db,
  businessId: string,
  userId: string,
  clientId: string,
) {
  return setArchived(db, businessId, userId, clientId, false);
}

export async function listActivity(
  db: Db,
  businessId: string,
  clientId: string,
) {
  // seq, not at: timestamps can collide within a microsecond and the
  // thread must render newest-first in stable insertion order.
  return db
    .select()
    .from(schema.activity)
    .where(
      and(
        eq(schema.activity.businessId, businessId),
        eq(schema.activity.clientId, clientId),
      ),
    )
    .orderBy(desc(schema.activity.seq));
}

// Cross-client recent activity for the dashboard, newest first.
export async function listRecentActivity(
  db: Db,
  businessId: string,
  limit: number,
) {
  return db
    .select({
      id: schema.activity.id,
      type: schema.activity.type,
      payload: schema.activity.payload,
      at: schema.activity.at,
      clientId: schema.activity.clientId,
      clientName: schema.client.name,
    })
    .from(schema.activity)
    .innerJoin(schema.client, eq(schema.activity.clientId, schema.client.id))
    .where(eq(schema.activity.businessId, businessId))
    .orderBy(desc(schema.activity.seq))
    .limit(limit);
}

// Bulk import for the CSV wizard. Names already present in the business
// (case-insensitive) are skipped, not duplicated - re-running an import
// is safe. Each created client goes through createClient so the activity
// thread and tenancy behaviour are identical to manual creation.
export async function importClients(
  db: Db,
  businessId: string,
  userId: string,
  rows: ClientInput[],
) {
  const existing = await db
    .select({ name: schema.client.name })
    .from(schema.client)
    .where(eq(schema.client.businessId, businessId));
  const taken = new Set(existing.map((c) => c.name.trim().toLowerCase()));

  let created = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (taken.has(key)) {
      skipped.push(row.name);
      continue;
    }
    await createClient(db, businessId, userId, row);
    taken.add(key);
    created += 1;
  }
  return { created, skipped };
}

// Per-client member rates, oldest first. Returns the raw rows including the
// internal cost; the router strips internal-cost fields for callers without
// reports.viewProfit, so it never leaks margin data to the wrong roles.
export async function listMemberRates(
  db: Db,
  businessId: string,
  clientId: string,
) {
  return db
    .select({
      id: schema.clientMemberRate.id,
      userId: schema.clientMemberRate.userId,
      name: schema.user.name,
      email: schema.user.email,
      billRateMinor: schema.clientMemberRate.billRateMinor,
      billRateCurrency: schema.clientMemberRate.billRateCurrency,
      billRateUnit: schema.clientMemberRate.billRateUnit,
      internalCostMinor: schema.clientMemberRate.internalCostMinor,
      internalCostCurrency: schema.clientMemberRate.internalCostCurrency,
      internalCostUnit: schema.clientMemberRate.internalCostUnit,
      budgetMinor: schema.clientMemberRate.budgetMinor,
      budgetCurrency: schema.clientMemberRate.budgetCurrency,
    })
    .from(schema.clientMemberRate)
    .innerJoin(schema.user, eq(schema.clientMemberRate.userId, schema.user.id))
    .where(
      and(
        eq(schema.clientMemberRate.businessId, businessId),
        eq(schema.clientMemberRate.clientId, clientId),
      ),
    )
    .orderBy(asc(schema.clientMemberRate.createdAt));
}

type MemberRateResult =
  | { ok: true; rate: typeof schema.clientMemberRate.$inferSelect }
  | { ok: false; reason: "client_not_found" | "not_member" };

// Upsert one member's rate on a client. Validates the client belongs to the
// business and the user is a member of it - a foreign client or non-member is
// rejected, never silently written. Keyed on (clientId, userId): re-setting
// updates in place. `internalCost` is only persisted when the caller passed it
// (the router gates that on reports.viewProfit), so a bill-rate-only edit by a
// member without profit access never wipes an existing internal cost.
export async function setMemberRate(
  db: Db,
  businessId: string,
  clientId: string,
  input: MemberRateInput,
  opts: { allowInternalCost: boolean },
): Promise<MemberRateResult> {
  return db.transaction(async (tx) => {
    const [client] = await tx
      .select({ id: schema.client.id })
      .from(schema.client)
      .where(
        and(
          eq(schema.client.businessId, businessId),
          eq(schema.client.id, clientId),
        ),
      );
    if (!client) return { ok: false, reason: "client_not_found" };

    const [member] = await tx
      .select({ id: schema.businessMember.id })
      .from(schema.businessMember)
      .where(
        and(
          eq(schema.businessMember.businessId, businessId),
          eq(schema.businessMember.userId, input.userId),
        ),
      );
    if (!member) return { ok: false, reason: "not_member" };

    const internalCostFields = opts.allowInternalCost
      ? {
          internalCostMinor: input.internalCostMinor ?? null,
          internalCostCurrency: input.internalCostCurrency ?? null,
          internalCostUnit: input.internalCostUnit ?? "hour",
        }
      : {};

    const [rate] = await tx
      .insert(schema.clientMemberRate)
      .values({
        businessId,
        clientId,
        userId: input.userId,
        billRateMinor: input.billRateMinor,
        billRateCurrency: input.billRateCurrency,
        billRateUnit: input.billRateUnit ?? "hour",
        budgetMinor: input.budgetMinor ?? null,
        budgetCurrency: input.budgetCurrency ?? null,
        ...internalCostFields,
      })
      .onConflictDoUpdate({
        target: [
          schema.clientMemberRate.clientId,
          schema.clientMemberRate.userId,
        ],
        set: {
          billRateMinor: input.billRateMinor,
          billRateCurrency: input.billRateCurrency,
          billRateUnit: input.billRateUnit ?? "hour",
          budgetMinor: input.budgetMinor ?? null,
          budgetCurrency: input.budgetCurrency ?? null,
          ...internalCostFields,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { ok: true, rate };
  });
}

export async function removeMemberRate(
  db: Db,
  businessId: string,
  clientId: string,
  userId: string,
) {
  const [deleted] = await db
    .delete(schema.clientMemberRate)
    .where(
      and(
        eq(schema.clientMemberRate.businessId, businessId),
        eq(schema.clientMemberRate.clientId, clientId),
        eq(schema.clientMemberRate.userId, userId),
      ),
    )
    .returning();
  return deleted ?? null;
}

export async function addNote(
  db: Db,
  businessId: string,
  userId: string,
  clientId: string,
  text: string,
) {
  // Notes attach only to clients of the caller's business.
  const target = await getClient(db, businessId, clientId);
  if (!target) {
    return null;
  }
  const [created] = await db
    .insert(schema.activity)
    .values({
      businessId,
      clientId,
      userId,
      type: "note",
      payload: { text },
    })
    .returning();
  return created;
}
