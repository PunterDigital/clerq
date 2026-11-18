// Invoice lifecycle (billing spec; statuses draft/sent/paid/overdue).
// draft -> sent happens in issueInvoice (numbering). sent -> overdue is
// flipped on read when the due date has passed - no background job yet,
// so reads are the source of truth and stay cheap and scoped. paid is a
// terminal state set explicitly.

import { and, desc, eq, ilike, inArray, isNull, lt, or } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";
import { likeContains } from "@/lib/search";

// Flips sent invoices past their due date to overdue for one business.
// Called by the read paths so a listed status is never stale.
export async function refreshOverdue(
  db: Db,
  businessId: string,
  now: Date = new Date(),
) {
  await db
    .update(schema.invoice)
    .set({ status: "overdue", updatedAt: now })
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.status, "sent"),
        lt(schema.invoice.dueDate, now),
      ),
    );
}

export async function listInvoices(
  db: Db,
  businessId: string,
  now: Date = new Date(),
  opts: { search?: string } = {},
) {
  await refreshOverdue(db, businessId, now);
  const filters = [eq(schema.invoice.businessId, businessId)];
  // Match on the invoice number or the client it's billed to.
  const term = opts.search?.trim();
  if (term) {
    const pattern = likeContains(term);
    filters.push(
      or(
        ilike(schema.invoice.number, pattern),
        ilike(schema.client.name, pattern),
      )!,
    );
  }
  return db
    .select({
      id: schema.invoice.id,
      number: schema.invoice.number,
      status: schema.invoice.status,
      currency: schema.invoice.currency,
      totalMinor: schema.invoice.totalMinor,
      // Covered by credit notes (#5042); the client owes the difference.
      creditedMinor: schema.invoice.creditedMinor,
      issueDate: schema.invoice.issueDate,
      dueDate: schema.invoice.dueDate,
      clientId: schema.invoice.clientId,
      clientName: schema.client.name,
      // Non-null when this invoice came from a recurring schedule (retainer);
      // the list tags it so a generated invoice is recognisable at a glance.
      scheduleId: schema.invoice.scheduleId,
      createdAt: schema.invoice.createdAt,
    })
    .from(schema.invoice)
    .innerJoin(schema.client, eq(schema.invoice.clientId, schema.client.id))
    .where(and(...filters))
    .orderBy(desc(schema.invoice.createdAt));
}

export async function getInvoice(
  db: Db,
  businessId: string,
  invoiceId: string,
  now: Date = new Date(),
) {
  await refreshOverdue(db, businessId, now);
  const [invoice] = await db
    .select()
    .from(schema.invoice)
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
      ),
    );
  if (!invoice) {
    return null;
  }
  const lines = await db
    .select()
    .from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, invoiceId))
    .orderBy(schema.invoiceLine.position);
  return { ...invoice, lines };
}

// sent or overdue -> paid. Drafts cannot be paid (they do not exist as
// documents yet) and paid is terminal.
export async function markInvoicePaid(
  db: Db,
  businessId: string,
  invoiceId: string,
) {
  const [updated] = await db
    .update(schema.invoice)
    .set({ status: "paid", updatedAt: new Date() })
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
        // Guard in SQL so a concurrent transition cannot double-apply.
        eq(schema.invoice.status, "sent"),
      ),
    )
    .returning();
  if (updated) {
    return updated;
  }
  const [updatedOverdue] = await db
    .update(schema.invoice)
    .set({ status: "paid", updatedAt: new Date() })
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
        eq(schema.invoice.status, "overdue"),
      ),
    )
    .returning();
  return updatedOverdue ?? null;
}

// sent or overdue -> void, for invoices that never went out as an
// e-invoice and have no credit notes (#5042). A voided invoice keeps its number (it remains a
// real document in the sequence) but no longer counts as revenue. void is
// terminal: paid invoices stay locked (money moved against them) and drafts
// are edited, not voided. The status guard is in SQL so a concurrent
// transition cannot double-apply, and the void is logged to the client's
// activity thread - both in one transaction. Voiding also releases any time
// billed on this invoice back to the unbilled pool: the work is no longer
// owed against a live document, so it can be billed again. The invoice's
// lines stay for the record - only the time_entry -> line link is cleared.
export async function voidInvoice(
  db: Db,
  businessId: string,
  userId: string,
  invoiceId: string,
  reason?: string | null,
) {
  const trimmedReason = reason?.trim() || null;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(schema.invoice)
      .set({
        status: "void",
        voidedAt: now,
        voidReason: trimmedReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, invoiceId),
          inArray(schema.invoice.status, ["sent", "overdue"]),
          // Once it went out as an e-invoice, or has credit notes, a
          // correction is a credit note instead (#5042).
          isNull(schema.invoice.einvoiceSentAt),
          eq(schema.invoice.creditedMinor, 0),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    // Unbill the entries billed on this invoice's lines, mirroring what a
    // draft line deletion does via ON DELETE SET NULL (spec Section 7).
    await tx
      .update(schema.timeEntry)
      .set({ invoiceLineId: null, updatedAt: now })
      .where(
        and(
          eq(schema.timeEntry.businessId, businessId),
          inArray(
            schema.timeEntry.invoiceLineId,
            tx
              .select({ id: schema.invoiceLine.id })
              .from(schema.invoiceLine)
              .where(eq(schema.invoiceLine.invoiceId, invoiceId)),
          ),
        ),
      );
    await tx.insert(schema.activity).values({
      businessId,
      clientId: updated.clientId,
      userId,
      type: "invoice_voided",
      payload: { number: updated.number, reason: trimmedReason },
    });
    return updated;
  });
}
