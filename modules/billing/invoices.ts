import { and, eq, isNotNull, max, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";
import { normalizeBuyerReference } from "@/lib/einvoice-codes";

import { invoiceTotals, type TaxTreatment } from "./tax";

// Invoice creation and numbering (billing spec Section 6).
// Numbers are YYYY-NNNN, sequential per business per calendar year,
// allocated inside the issuing transaction with the sequence row locked -
// no gaps, no duplicates, correct under concurrency. Drafts are
// unnumbered until issued.

export function formatInvoiceNumber(year: number, n: number): string {
  return `${year}-${String(n).padStart(4, "0")}`;
}

export async function createDraftInvoice(
  db: Db,
  businessId: string,
  input: {
    clientId: string;
    projectId?: string | null;
    currency: string;
    taxTreatment: TaxTreatment;
    standardRatePercent?: string;
    issueDate?: Date | null;
    dueDate?: Date | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    notes?: string | null;
  },
) {
  // The client (and project, when given) must belong to the business.
  const [clientRow] = await db
    .select({
      id: schema.client.id,
      buyerReference: schema.client.buyerReference,
    })
    .from(schema.client)
    .where(
      and(
        eq(schema.client.businessId, businessId),
        eq(schema.client.id, input.clientId),
      ),
    );
  if (!clientRow) {
    return null;
  }
  if (input.projectId) {
    const [projectRow] = await db
      .select({ id: schema.project.id, clientId: schema.project.clientId })
      .from(schema.project)
      .where(
        and(
          eq(schema.project.businessId, businessId),
          eq(schema.project.id, input.projectId),
        ),
      );
    if (!projectRow || projectRow.clientId !== input.clientId) {
      return null;
    }
  }

  // Empty totals now; lines recompute them. Validates the treatment/rate
  // combination immediately so a misconfigured draft cannot exist.
  const totals = invoiceTotals({
    lineTotalsMinor: [],
    treatment: input.taxTreatment,
    standardRatePercent: input.standardRatePercent,
  });

  const [created] = await db
    .insert(schema.invoice)
    .values({
      businessId,
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      currency: input.currency,
      taxTreatment: input.taxTreatment,
      taxRatePercent: totals.taxRatePercent,
      taxNote: totals.taxNote,
      // The client's default PO number / buyer reference; editable per draft.
      buyerReference: clientRow.buyerReference,
      issueDate: input.issueDate ?? null,
      dueDate: input.dueDate ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return created;
}

// Copies an invoice (any status) into a fresh draft: a new editable document
// with the same client, project, currency, tax setup and lines, but no number,
// issue date or status carried over. The copied lines are detached from the
// source's time entries - duplication never re-points an entry's invoiceLineId,
// so the original invoice keeps its full traceability. Totals are recomputed
// from the copied lines (identical to the source, since the tax setup is the
// same). Returns the new draft, or null if the source is not found.
export async function duplicateInvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
) {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, invoiceId),
        ),
      );
    if (!source) {
      return null;
    }
    const sourceLines = await tx
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId))
      .orderBy(schema.invoiceLine.position);

    const [draft] = await tx
      .insert(schema.invoice)
      .values({
        businessId,
        clientId: source.clientId,
        projectId: source.projectId,
        currency: source.currency,
        taxTreatment: source.taxTreatment,
        taxRatePercent: source.taxRatePercent,
        taxNote: source.taxNote,
        vatexCode: source.vatexCode,
        buyerReference: source.buyerReference,
        dueDate: source.dueDate,
        periodStart: source.periodStart,
        periodEnd: source.periodEnd,
        notes: source.notes,
      })
      .returning();

    if (sourceLines.length > 0) {
      await tx.insert(schema.invoiceLine).values(
        sourceLines.map((line) => ({
          businessId,
          invoiceId: draft.id,
          position: line.position,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalMinor: line.totalMinor,
          unitCode: line.unitCode,
          sourceCurrency: line.sourceCurrency,
          sourceTotalMinor: line.sourceTotalMinor,
          fxRate: line.fxRate,
          fxSource: line.fxSource,
        })),
      );
    }

    const totals = invoiceTotals({
      lineTotalsMinor: sourceLines.map((l) => l.totalMinor),
      treatment: source.taxTreatment,
      standardRatePercent:
        source.taxTreatment === "standard" ? source.taxRatePercent : undefined,
    });
    const [updated] = await tx
      .update(schema.invoice)
      .set({
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        updatedAt: new Date(),
      })
      .where(eq(schema.invoice.id, draft.id))
      .returning();
    return updated;
  });
}

// Edits the dated metadata of a draft: the issue date used (and dated) when
// it is issued, the due date, and the optional billing period. Draft-only,
// like every other invoice edit. Each field is set to exactly what is passed
// (omit nothing - the caller sends the full set), so clearing is explicit.
// Returns the updated invoice, or null when there is no draft to edit.
export async function updateInvoiceDetails(
  db: Db,
  businessId: string,
  invoiceId: string,
  input: {
    issueDate: Date | null;
    dueDate: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    // E-invoicing fields (#5039): left out = keep, null = clear.
    buyerReference?: string | null;
    vatexCode?: string | null;
  },
) {
  const [updated] = await db
    .update(schema.invoice)
    .set({
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      ...(input.buyerReference !== undefined
        ? { buyerReference: normalizeBuyerReference(input.buyerReference) }
        : {}),
      ...(input.vatexCode !== undefined ? { vatexCode: input.vatexCode } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
        eq(schema.invoice.status, "draft"),
      ),
    )
    .returning();
  return updated ?? null;
}

// Deletes a draft outright. Only drafts can be deleted - issued invoices are
// documents in the sequence (void them instead). The line cascade drops the
// invoice's lines, which releases their time entries back to the unbilled pool
// (timeEntry.invoiceLineId is ON DELETE SET NULL). Returns the deleted id, or
// null when there is no draft to delete.
export async function deleteDraftInvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
) {
  const [deleted] = await db
    .delete(schema.invoice)
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
        eq(schema.invoice.status, "draft"),
      ),
    )
    .returning({ id: schema.invoice.id });
  return deleted ?? null;
}

export type IssueResult =
  | { ok: true; invoice: typeof schema.invoice.$inferSelect }
  | {
      ok: false;
      reason: "not_found" | "missing_vat_numbers";
      missing?: ("business" | "client")[];
    };

// Issues a draft: allocates the next number for (business, issue year)
// under a row lock and stamps number, year, issue date and status in the
// same transaction. A draft can carry a chosen issue date (set on the draft,
// e.g. to backdate a re-issued copy); when present it wins over the caller's
// default and drives the numbering year. Reverse-charge invoices cannot be
// issued unless both parties' VAT numbers exist - the spec mandates them
// printed (Section 4) and an EU reverse-charge invoice without them is not a
// valid document.
export async function issueInvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
  issueDate: Date = new Date(),
): Promise<IssueResult> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select({
        id: schema.invoice.id,
        status: schema.invoice.status,
        taxTreatment: schema.invoice.taxTreatment,
        clientId: schema.invoice.clientId,
        issueDate: schema.invoice.issueDate,
      })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, invoiceId),
        ),
      )
      .for("update");
    if (!draft || draft.status !== "draft") {
      return { ok: false as const, reason: "not_found" as const };
    }

    // A date chosen on the draft takes precedence; the year follows it so the
    // number lands in the right annual sequence.
    const effectiveIssueDate = draft.issueDate ?? issueDate;
    const year = effectiveIssueDate.getUTCFullYear();

    if (draft.taxTreatment === "reverse_charge") {
      const [businessRow] = await tx
        .select({ taxConfig: schema.business.taxConfig })
        .from(schema.business)
        .where(eq(schema.business.id, businessId));
      const [clientRow] = await tx
        .select({ vatNumber: schema.client.vatNumber })
        .from(schema.client)
        .where(eq(schema.client.id, draft.clientId));
      const businessVat = (
        (businessRow?.taxConfig ?? {}) as { vatNumber?: string }
      ).vatNumber;
      const missing: ("business" | "client")[] = [];
      if (!businessVat) {
        missing.push("business");
      }
      if (!clientRow?.vatNumber) {
        missing.push("client");
      }
      if (missing.length > 0) {
        return {
          ok: false as const,
          reason: "missing_vat_numbers" as const,
          missing,
        };
      }
    }

    // Ensure the sequence row exists, then lock it for this transaction.
    await tx
      .insert(schema.invoiceSequence)
      .values({ businessId, year })
      .onConflictDoNothing();
    const [seq] = await tx
      .select()
      .from(schema.invoiceSequence)
      .where(
        and(
          eq(schema.invoiceSequence.businessId, businessId),
          eq(schema.invoiceSequence.year, year),
        ),
      )
      .for("update");

    const allocated = seq.nextNumber;
    await tx
      .update(schema.invoiceSequence)
      .set({ nextNumber: allocated + 1, updatedAt: new Date() })
      .where(eq(schema.invoiceSequence.id, seq.id));

    const [issued] = await tx
      .update(schema.invoice)
      .set({
        status: "sent",
        number: formatInvoiceNumber(year, allocated),
        year,
        issueDate: effectiveIssueDate,
        updatedAt: new Date(),
      })
      .where(eq(schema.invoice.id, invoiceId))
      .returning();
    return { ok: true as const, invoice: issued };
  });
}

// Spec Section 6 (Shay's review feedback): a migrating business can set
// where this year's sequence continues. The configured next number must
// exceed every number Clerq has already issued for that year.
export async function configureNextInvoiceNumber(
  db: Db,
  businessId: string,
  year: number,
  nextNumber: number,
) {
  if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > 9999) {
    return { ok: false as const, reason: "Next number must be between 1 and 9999" };
  }
  return db.transaction(async (tx) => {
    const [highest] = await tx
      .select({
        value: max(
          sql<number>`cast(split_part(${schema.invoice.number}, '-', 2) as integer)`,
        ),
      })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.year, year),
          isNotNull(schema.invoice.number),
        ),
      );
    // pg drivers return aggregates as strings; the cast keeps this exact.
    const issuedMax = Number(highest?.value ?? 0);
    if (nextNumber <= issuedMax) {
      return {
        ok: false as const,
        reason: `Already issued up to ${formatInvoiceNumber(year, issuedMax)} - the next number must be at least ${issuedMax + 1}`,
      };
    }
    await tx
      .insert(schema.invoiceSequence)
      .values({ businessId, year, nextNumber })
      .onConflictDoUpdate({
        target: [schema.invoiceSequence.businessId, schema.invoiceSequence.year],
        set: { nextNumber, updatedAt: new Date() },
      });
    return { ok: true as const };
  });
}
