// Credit notes (#5042, EN 16931 type 381). Once an invoice may have gone out
// as an e-invoice it can't be withdrawn, only corrected: a credit note with
// its own number that references the original invoice and credits some or
// all of its lines. Credit notes are issued straight away (no draft) and
// numbered gaplessly per business per year from credit_note_sequence, with
// the business's prefix (default "CN-").
//
// Rules:
// - Only issued invoices (sent, overdue, paid) can be credited.
// - Each invoice line can be credited up to its own total across all credit
//   notes; the credit note's tax follows the invoice's treatment and rate,
//   capped so the credited tax never exceeds the invoice's tax.
// - When the credit notes cover the whole total of a sent/overdue invoice
//   it becomes "credited" (nothing is owed) and its billed time goes back
//   to unbilled, as voiding did. A paid invoice stays paid (a refund is
//   owed, which Clerq doesn't track).

import { and, desc, eq, inArray, isNull, sum } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";
import { formatMoney } from "@/lib/format";

import { invoiceTotals } from "./tax";

export const CREDITABLE_STATUSES = ["sent", "overdue", "paid"] as const;

export function formatCreditNoteNumber(
  prefix: string,
  year: number,
  n: number,
): string {
  return `${prefix}${year}-${String(n).padStart(4, "0")}`;
}

// Prefixes are short, printable and end the number cleanly: letters,
// digits and - / _ . only, up to 10 characters (empty is allowed).
export const CREDIT_NOTE_PREFIX_PATTERN = /^[A-Za-z0-9\-/_.]{0,10}$/;

export type CreditableLine = {
  invoiceLineId: string;
  description: string;
  totalMinor: number;
  creditedMinor: number;
  remainingMinor: number;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// What each line of the invoice has been credited so far.
async function creditedByLine(
  db: Db | Tx,
  invoiceId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      invoiceLineId: schema.creditNoteLine.invoiceLineId,
      credited: sum(schema.creditNoteLine.totalMinor),
    })
    .from(schema.creditNoteLine)
    .innerJoin(
      schema.creditNote,
      eq(schema.creditNoteLine.creditNoteId, schema.creditNote.id),
    )
    .where(eq(schema.creditNote.invoiceId, invoiceId))
    .groupBy(schema.creditNoteLine.invoiceLineId);
  // pg drivers return sums as strings; Number keeps integers exact here.
  return new Map(rows.map((r) => [r.invoiceLineId, Number(r.credited ?? 0)]));
}

function creditableLines(
  lines: { id: string; description: string; totalMinor: number }[],
  credited: Map<string, number>,
): CreditableLine[] {
  return lines.map((line) => {
    const creditedMinor = credited.get(line.id) ?? 0;
    return {
      invoiceLineId: line.id,
      description: line.description,
      totalMinor: line.totalMinor,
      creditedMinor,
      remainingMinor: line.totalMinor - creditedMinor,
    };
  });
}

// The credit notes of one invoice plus what is left to credit, for the
// invoice page. null when the invoice isn't in the business.
export async function getInvoiceCredits(
  db: Db,
  businessId: string,
  invoiceId: string,
) {
  const [invoice] = await db
    .select({
      id: schema.invoice.id,
      status: schema.invoice.status,
      totalMinor: schema.invoice.totalMinor,
      creditedMinor: schema.invoice.creditedMinor,
      einvoiceSentAt: schema.invoice.einvoiceSentAt,
    })
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
    .select({
      id: schema.invoiceLine.id,
      description: schema.invoiceLine.description,
      totalMinor: schema.invoiceLine.totalMinor,
    })
    .from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, invoiceId))
    .orderBy(schema.invoiceLine.position);
  const creditNotes = await db
    .select({
      id: schema.creditNote.id,
      number: schema.creditNote.number,
      issueDate: schema.creditNote.issueDate,
      totalMinor: schema.creditNote.totalMinor,
      reason: schema.creditNote.reason,
    })
    .from(schema.creditNote)
    .where(
      and(
        eq(schema.creditNote.businessId, businessId),
        eq(schema.creditNote.invoiceId, invoiceId),
      ),
    )
    .orderBy(schema.creditNote.createdAt);
  const remainingMinor = invoice.totalMinor - invoice.creditedMinor;
  const creditable = (CREDITABLE_STATUSES as readonly string[]).includes(
    invoice.status,
  );
  return {
    creditNotes,
    lines: creditableLines(lines, await creditedByLine(db, invoiceId)),
    creditedMinor: invoice.creditedMinor,
    remainingMinor,
    canCredit: creditable && remainingMinor > 0,
    // Void is only for invoices that never went out as an e-invoice and
    // have no credit notes (#5042).
    canVoid:
      (invoice.status === "sent" || invoice.status === "overdue") &&
      invoice.einvoiceSentAt === null &&
      invoice.creditedMinor === 0,
    einvoiceSent: invoice.einvoiceSentAt !== null,
  };
}

export type IssueCreditNoteInput = {
  invoiceId: string;
  // Lines to credit and how much (minor units, same sign as the line).
  // Left out: every line's remaining amount (a full credit).
  lines?: { invoiceLineId: string; amountMinor: number }[];
  reason?: string | null;
};

export type IssueCreditNoteResult =
  | { ok: true; creditNote: typeof schema.creditNote.$inferSelect }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_creditable"
        | "nothing_to_credit"
        | "invalid_line";
      message: string;
    };

export async function issueCreditNote(
  db: Db,
  businessId: string,
  userId: string | null,
  input: IssueCreditNoteInput,
  issueDate: Date = new Date(),
): Promise<IssueCreditNoteResult> {
  const reason = input.reason?.trim() || null;
  return db.transaction(async (tx) => {
    // Lock the invoice so two credit notes can't both take the same
    // remaining amount.
    const [invoice] = await tx
      .select()
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, input.invoiceId),
        ),
      )
      .for("update");
    if (!invoice) {
      return { ok: false, reason: "not_found", message: "No such invoice" };
    }
    if (
      !(CREDITABLE_STATUSES as readonly string[]).includes(invoice.status)
    ) {
      return {
        ok: false,
        reason: "not_creditable",
        message:
          invoice.status === "draft"
            ? "Drafts aren't credited - edit or delete the draft instead"
            : `A ${invoice.status} invoice can't be credited`,
      };
    }

    const invoiceLines = await tx
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoice.id))
      .orderBy(schema.invoiceLine.position);
    const lines = creditableLines(
      invoiceLines,
      await creditedByLine(tx, invoice.id),
    );
    const byId = new Map(lines.map((l) => [l.invoiceLineId, l]));

    const requested =
      input.lines ??
      lines
        .filter((l) => l.remainingMinor !== 0)
        .map((l) => ({
          invoiceLineId: l.invoiceLineId,
          amountMinor: l.remainingMinor,
        }));
    const picked: { line: CreditableLine; amountMinor: number }[] = [];
    const seen = new Set<string>();
    for (const r of requested) {
      const line = byId.get(r.invoiceLineId);
      if (!line || seen.has(r.invoiceLineId)) {
        return {
          ok: false,
          reason: "invalid_line",
          message: "A line isn't on this invoice",
        };
      }
      seen.add(r.invoiceLineId);
      if (!Number.isInteger(r.amountMinor) || r.amountMinor === 0) {
        continue;
      }
      // Same sign as what's left on the line, and never more than that.
      if (
        Math.sign(r.amountMinor) !== Math.sign(line.remainingMinor) ||
        Math.abs(r.amountMinor) > Math.abs(line.remainingMinor)
      ) {
        return {
          ok: false,
          reason: "invalid_line",
          message: `"${firstLine(line.description)}" has only ${formatMoney(line.remainingMinor, invoice.currency)} left to credit`,
        };
      }
      picked.push({ line, amountMinor: r.amountMinor });
    }
    if (picked.length === 0) {
      return {
        ok: false,
        reason: "nothing_to_credit",
        message: "Pick at least one line and an amount to credit",
      };
    }

    // Tax as on the invoice: same treatment and rate, on this note's lines.
    const totals = invoiceTotals({
      lineTotalsMinor: picked.map((p) => p.amountMinor),
      treatment: invoice.taxTreatment,
      standardRatePercent: invoice.taxRatePercent,
    });
    const [priorTax] = await tx
      .select({ tax: sum(schema.creditNote.taxMinor) })
      .from(schema.creditNote)
      .where(eq(schema.creditNote.invoiceId, invoice.id));
    const taxLeft = invoice.taxMinor - Number(priorTax?.tax ?? 0);
    const settlesEveryLine = lines.every((l) => {
      const p = picked.find((x) => x.line.invoiceLineId === l.invoiceLineId);
      return l.remainingMinor === (p?.amountMinor ?? 0);
    });
    // Rounding per note could drift past the invoice's own tax; the note
    // that settles the last line takes exactly what is left.
    const taxMinor = settlesEveryLine
      ? taxLeft
      : Math.min(totals.taxMinor, taxLeft);
    const totalMinor = totals.subtotalMinor + taxMinor;
    const remaining = invoice.totalMinor - invoice.creditedMinor;
    if (totalMinor <= 0 || totalMinor > remaining) {
      return {
        ok: false,
        reason: "nothing_to_credit",
        message: "The credit note must be more than zero and at most what is left on the invoice",
      };
    }

    const [business] = await tx
      .select({ prefix: schema.business.creditNotePrefix })
      .from(schema.business)
      .where(eq(schema.business.id, businessId));
    const year = issueDate.getUTCFullYear();
    await tx
      .insert(schema.creditNoteSequence)
      .values({ businessId, year })
      .onConflictDoNothing();
    const [seq] = await tx
      .select()
      .from(schema.creditNoteSequence)
      .where(
        and(
          eq(schema.creditNoteSequence.businessId, businessId),
          eq(schema.creditNoteSequence.year, year),
        ),
      )
      .for("update");
    await tx
      .update(schema.creditNoteSequence)
      .set({ nextNumber: seq.nextNumber + 1, updatedAt: new Date() })
      .where(eq(schema.creditNoteSequence.id, seq.id));

    const [creditNote] = await tx
      .insert(schema.creditNote)
      .values({
        businessId,
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        number: formatCreditNoteNumber(business?.prefix ?? "CN-", year, seq.nextNumber),
        year,
        currency: invoice.currency,
        issueDate,
        taxTreatment: invoice.taxTreatment,
        taxRatePercent: totals.taxRatePercent,
        taxNote: totals.taxNote,
        vatexCode: invoice.vatexCode,
        buyerReference: invoice.buyerReference,
        subtotalMinor: totals.subtotalMinor,
        taxMinor,
        totalMinor,
        reason,
        createdByUserId: userId,
      })
      .returning();

    const source = new Map(invoiceLines.map((l) => [l.id, l]));
    await tx.insert(schema.creditNoteLine).values(
      picked.map(({ line, amountMinor }, i) => {
        const original = source.get(line.invoiceLineId)!;
        // The hours x rate breakdown only still holds for a whole line.
        const whole =
          line.creditedMinor === 0 && amountMinor === original.totalMinor;
        return {
          businessId,
          creditNoteId: creditNote.id,
          invoiceLineId: line.invoiceLineId,
          position: i,
          description: original.description,
          quantity: whole ? original.quantity : null,
          unitPriceMinor: whole ? original.unitPriceMinor : null,
          totalMinor: amountMinor,
          unitCode: whole ? original.unitCode : "C62",
        };
      }),
    );

    const creditedMinor = invoice.creditedMinor + totalMinor;
    const fullyCredited = creditedMinor === invoice.totalMinor;
    const closes =
      fullyCredited &&
      (invoice.status === "sent" || invoice.status === "overdue");
    const now = new Date();
    await tx
      .update(schema.invoice)
      .set({
        creditedMinor,
        ...(closes ? { status: "credited" as const } : {}),
        updatedAt: now,
      })
      .where(eq(schema.invoice.id, invoice.id));
    if (closes) {
      // As with a void: the work is no longer owed on a live document, so
      // its time can be billed again on a corrected invoice.
      await tx
        .update(schema.timeEntry)
        .set({ invoiceLineId: null, updatedAt: now })
        .where(
          and(
            eq(schema.timeEntry.businessId, businessId),
            inArray(
              schema.timeEntry.invoiceLineId,
              invoiceLines.map((l) => l.id),
            ),
          ),
        );
    }

    await tx.insert(schema.activity).values({
      businessId,
      clientId: invoice.clientId,
      userId,
      type: "credit_note_issued",
      payload: {
        number: creditNote.number,
        invoiceNumber: invoice.number,
        totalMinor,
        currency: invoice.currency,
        reason,
      },
    });
    return { ok: true, creditNote };
  });
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 60);
}

export async function getCreditNote(
  db: Db,
  businessId: string,
  creditNoteId: string,
) {
  const [row] = await db
    .select({
      creditNote: schema.creditNote,
      invoiceNumber: schema.invoice.number,
      invoiceIssueDate: schema.invoice.issueDate,
    })
    .from(schema.creditNote)
    .innerJoin(schema.invoice, eq(schema.creditNote.invoiceId, schema.invoice.id))
    .where(
      and(
        eq(schema.creditNote.businessId, businessId),
        eq(schema.creditNote.id, creditNoteId),
      ),
    );
  if (!row) {
    return null;
  }
  const lines = await db
    .select()
    .from(schema.creditNoteLine)
    .where(eq(schema.creditNoteLine.creditNoteId, creditNoteId))
    .orderBy(schema.creditNoteLine.position);
  return {
    ...row.creditNote,
    invoiceNumber: row.invoiceNumber,
    invoiceIssueDate: row.invoiceIssueDate,
    lines,
  };
}

export async function listCreditNotes(db: Db, businessId: string) {
  return db
    .select({
      id: schema.creditNote.id,
      number: schema.creditNote.number,
      issueDate: schema.creditNote.issueDate,
      currency: schema.creditNote.currency,
      totalMinor: schema.creditNote.totalMinor,
      invoiceId: schema.creditNote.invoiceId,
      invoiceNumber: schema.invoice.number,
      clientId: schema.creditNote.clientId,
      clientName: schema.client.name,
    })
    .from(schema.creditNote)
    .innerJoin(schema.invoice, eq(schema.creditNote.invoiceId, schema.invoice.id))
    .innerJoin(schema.client, eq(schema.creditNote.clientId, schema.client.id))
    .where(eq(schema.creditNote.businessId, businessId))
    .orderBy(desc(schema.creditNote.createdAt));
}

// Records that the invoice left Clerq as an e-invoice (XML download or a
// PDF with Factur-X attached). Only the first time is kept.
export async function recordEinvoiceSent(
  db: Db,
  businessId: string,
  invoiceId: string,
  at: Date = new Date(),
) {
  await db
    .update(schema.invoice)
    .set({ einvoiceSentAt: at })
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
        isNull(schema.invoice.einvoiceSentAt),
      ),
    );
}

// Why a sent/overdue invoice can't be voided any more, or null when it can.
export function voidBlockedReason(invoice: {
  einvoiceSentAt: Date | null;
  creditedMinor: number;
}): string | null {
  if (invoice.einvoiceSentAt) {
    return "This invoice went out as an e-invoice, so it can't be voided - issue a credit note instead";
  }
  if (invoice.creditedMinor > 0) {
    return "This invoice has credit notes, so it can't be voided - credit the rest instead";
  }
  return null;
}

