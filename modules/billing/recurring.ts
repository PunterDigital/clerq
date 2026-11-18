// Recurring invoices / retainers: the service layer over invoice_schedule.
// A schedule is a template (client + tax setup + fixed-amount lines) plus a
// cadence. When next_run_at comes due, materialiseOccurrence stamps out a new
// draft invoice and advances next_run_at to the following occurrence.
//
// Generation is a system action, not a user's: runDueSchedules sweeps every
// business (the in-process scheduler and the /api/cron/run endpoint both call
// it), so nothing here takes a userId. It is safe under concurrency and
// re-entrancy: each schedule is claimed with SELECT ... FOR UPDATE and its
// next_run_at advanced in the same transaction (the pattern invoice numbering
// already uses), so two overlapping ticks can never double-bill.

import { and, asc, eq, lte } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";

import { issueInvoice } from "./invoices";
import {
  anchorDayForStart,
  nextOccurrence,
  type Cadence,
  type Frequency,
} from "./recurrence";
import { invoiceTotals, type TaxTreatment } from "./tax";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A single tick never generates more than this many invoices for one schedule.
// It only matters as a catch-up backstop: if a weekly schedule's start date is
// years in the past, we bill forward in bounded steps rather than in one
// unbounded burst, and the remainder rolls to the next tick.
const MAX_CATCHUP_PER_RUN = 60;

export type ScheduleLineInput = { description: string; amountMinor: number };

export type ScheduleInput = {
  clientId: string;
  projectId?: string | null;
  name: string;
  currency: string;
  taxTreatment: TaxTreatment;
  frequency: Frequency;
  interval: number;
  startDate: Date;
  endDate?: Date | null;
  occurrenceLimit?: number | null;
  netTermsDays: number;
  autoIssue: boolean;
  notes?: string | null;
  lines: ScheduleLineInput[];
};

type ScheduleRow = typeof schema.invoiceSchedule.$inferSelect;
type ScheduleLineRow = typeof schema.invoiceScheduleLine.$inferSelect;

function cadenceOf(schedule: ScheduleRow): Cadence {
  return {
    frequency: schedule.frequency,
    interval: schedule.interval,
    anchorDay: schedule.anchorDay,
  };
}

// The business's configured standard VAT rate, needed only when a schedule's
// treatment is standard. Read live at generation time (not frozen on the
// schedule) so a rate change flows through to future runs, exactly like a
// hand-made invoice.
async function standardRatePercentFor(
  db: Db,
  businessId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ taxConfig: schema.business.taxConfig })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  return ((row?.taxConfig ?? {}) as { standardRatePct?: string }).standardRatePct;
}

// Confirms a client (and project, when given) belongs to the business - the
// same ownership check createDraftInvoice makes.
async function assertClientAndProject(
  db: Db,
  businessId: string,
  clientId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  const [clientRow] = await db
    .select({ id: schema.client.id })
    .from(schema.client)
    .where(
      and(eq(schema.client.businessId, businessId), eq(schema.client.id, clientId)),
    );
  if (!clientRow) return false;
  if (projectId) {
    const [projectRow] = await db
      .select({ id: schema.project.id, clientId: schema.project.clientId })
      .from(schema.project)
      .where(
        and(
          eq(schema.project.businessId, businessId),
          eq(schema.project.id, projectId),
        ),
      );
    if (!projectRow || projectRow.clientId !== clientId) return false;
  }
  return true;
}

export async function createSchedule(
  db: Db,
  businessId: string,
  input: ScheduleInput,
): Promise<ScheduleRow | null> {
  if (!(await assertClientAndProject(db, businessId, input.clientId, input.projectId))) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.invoiceSchedule)
      .values({
        businessId,
        clientId: input.clientId,
        projectId: input.projectId ?? null,
        name: input.name,
        currency: input.currency,
        taxTreatment: input.taxTreatment,
        frequency: input.frequency,
        interval: input.interval,
        anchorDay: anchorDayForStart(input.startDate, input.frequency),
        startDate: input.startDate,
        // The first occurrence is the start date itself.
        nextRunAt: input.startDate,
        endDate: input.endDate ?? null,
        occurrenceLimit: input.occurrenceLimit ?? null,
        netTermsDays: input.netTermsDays,
        autoIssue: input.autoIssue,
        notes: input.notes ?? null,
      })
      .returning();
    await insertLines(tx, businessId, created.id, input.lines);
    return created;
  });
}

async function insertLines(
  db: Db,
  businessId: string,
  scheduleId: string,
  lines: ScheduleLineInput[],
): Promise<void> {
  if (lines.length === 0) return;
  await db.insert(schema.invoiceScheduleLine).values(
    lines.map((line, i) => ({
      businessId,
      scheduleId,
      position: i + 1,
      description: line.description,
      amountMinor: line.amountMinor,
    })),
  );
}

// Edits a schedule's template and cadence. Lines are replaced wholesale (the
// caller sends the full set). The anchor day is recomputed from the (possibly
// new) start date and frequency. next_run_at is only re-pinned to the start
// date when nothing has generated yet; once a schedule has produced invoices,
// its place in the series is kept and cadence changes apply from there.
export async function updateSchedule(
  db: Db,
  businessId: string,
  scheduleId: string,
  input: ScheduleInput,
): Promise<ScheduleRow | null> {
  if (!(await assertClientAndProject(db, businessId, input.clientId, input.projectId))) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.invoiceSchedule)
      .where(
        and(
          eq(schema.invoiceSchedule.businessId, businessId),
          eq(schema.invoiceSchedule.id, scheduleId),
        ),
      )
      .for("update");
    if (!existing) return null;

    const [updated] = await tx
      .update(schema.invoiceSchedule)
      .set({
        clientId: input.clientId,
        projectId: input.projectId ?? null,
        name: input.name,
        currency: input.currency,
        taxTreatment: input.taxTreatment,
        frequency: input.frequency,
        interval: input.interval,
        anchorDay: anchorDayForStart(input.startDate, input.frequency),
        startDate: input.startDate,
        nextRunAt:
          existing.generatedCount === 0 ? input.startDate : existing.nextRunAt,
        endDate: input.endDate ?? null,
        occurrenceLimit: input.occurrenceLimit ?? null,
        netTermsDays: input.netTermsDays,
        autoIssue: input.autoIssue,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.invoiceSchedule.id, scheduleId))
      .returning();

    await tx
      .delete(schema.invoiceScheduleLine)
      .where(eq(schema.invoiceScheduleLine.scheduleId, scheduleId));
    await insertLines(tx, businessId, scheduleId, input.lines);
    return updated;
  });
}

// active <-> paused, and either -> ended. Ended is terminal (to restart, make
// a fresh schedule). Resuming rolls next_run_at forward past any occurrences
// missed while paused, so a pause is a skip, never a deferred back-bill.
export async function setScheduleStatus(
  db: Db,
  businessId: string,
  scheduleId: string,
  status: "active" | "paused" | "ended",
  now: Date = new Date(),
): Promise<ScheduleRow | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.invoiceSchedule)
      .where(
        and(
          eq(schema.invoiceSchedule.businessId, businessId),
          eq(schema.invoiceSchedule.id, scheduleId),
        ),
      )
      .for("update");
    // Missing, or already ended (terminal): nothing to change.
    if (!existing || existing.status === "ended") return null;

    let nextRunAt = existing.nextRunAt;
    if (status === "active" && existing.status === "paused") {
      const cadence = cadenceOf(existing);
      let guard = 0;
      while (nextRunAt <= now && guard < 1000) {
        nextRunAt = nextOccurrence(nextRunAt, cadence);
        guard += 1;
      }
    }

    const [updated] = await tx
      .update(schema.invoiceSchedule)
      .set({ status, nextRunAt, updatedAt: now })
      .where(eq(schema.invoiceSchedule.id, scheduleId))
      .returning();
    return updated;
  });
}

// Deletes a schedule. Its template lines cascade; the invoices it already
// produced keep standing (invoice.schedule_id is ON DELETE SET NULL) - they
// are real documents, not the schedule's to revoke.
export async function deleteSchedule(
  db: Db,
  businessId: string,
  scheduleId: string,
): Promise<{ id: string } | null> {
  const [deleted] = await db
    .delete(schema.invoiceSchedule)
    .where(
      and(
        eq(schema.invoiceSchedule.businessId, businessId),
        eq(schema.invoiceSchedule.id, scheduleId),
      ),
    )
    .returning({ id: schema.invoiceSchedule.id });
  return deleted ?? null;
}

export async function getSchedule(db: Db, businessId: string, scheduleId: string) {
  const [row] = await db
    .select({
      schedule: schema.invoiceSchedule,
      clientName: schema.client.name,
    })
    .from(schema.invoiceSchedule)
    .innerJoin(
      schema.client,
      eq(schema.invoiceSchedule.clientId, schema.client.id),
    )
    .where(
      and(
        eq(schema.invoiceSchedule.businessId, businessId),
        eq(schema.invoiceSchedule.id, scheduleId),
      ),
    );
  if (!row) return null;
  const lines = await db
    .select()
    .from(schema.invoiceScheduleLine)
    .where(eq(schema.invoiceScheduleLine.scheduleId, scheduleId))
    .orderBy(asc(schema.invoiceScheduleLine.position));
  return { ...row.schedule, clientName: row.clientName, lines };
}

export async function listSchedules(db: Db, businessId: string) {
  const schedules = await db
    .select({
      id: schema.invoiceSchedule.id,
      name: schema.invoiceSchedule.name,
      status: schema.invoiceSchedule.status,
      currency: schema.invoiceSchedule.currency,
      frequency: schema.invoiceSchedule.frequency,
      interval: schema.invoiceSchedule.interval,
      nextRunAt: schema.invoiceSchedule.nextRunAt,
      autoIssue: schema.invoiceSchedule.autoIssue,
      generatedCount: schema.invoiceSchedule.generatedCount,
      lastError: schema.invoiceSchedule.lastError,
      clientId: schema.invoiceSchedule.clientId,
      clientName: schema.client.name,
      createdAt: schema.invoiceSchedule.createdAt,
    })
    .from(schema.invoiceSchedule)
    .innerJoin(
      schema.client,
      eq(schema.invoiceSchedule.clientId, schema.client.id),
    )
    .where(eq(schema.invoiceSchedule.businessId, businessId))
    .orderBy(asc(schema.invoiceSchedule.name));

  // The per-schedule template total, summed in JS - a business has a handful
  // of schedules, not thousands, so a second small read beats a grouped join.
  const lines = await db
    .select({
      scheduleId: schema.invoiceScheduleLine.scheduleId,
      amountMinor: schema.invoiceScheduleLine.amountMinor,
    })
    .from(schema.invoiceScheduleLine)
    .where(eq(schema.invoiceScheduleLine.businessId, businessId));
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.scheduleId, (totals.get(line.scheduleId) ?? 0) + line.amountMinor);
  }

  return schedules.map((s) => ({ ...s, subtotalMinor: totals.get(s.id) ?? 0 }));
}

// The invoices a schedule has produced, newest first - shown on its page.
export async function listGeneratedInvoices(
  db: Db,
  businessId: string,
  scheduleId: string,
) {
  return db
    .select({
      id: schema.invoice.id,
      number: schema.invoice.number,
      status: schema.invoice.status,
      currency: schema.invoice.currency,
      totalMinor: schema.invoice.totalMinor,
      issueDate: schema.invoice.issueDate,
      dueDate: schema.invoice.dueDate,
      createdAt: schema.invoice.createdAt,
    })
    .from(schema.invoice)
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.scheduleId, scheduleId),
      ),
    )
    .orderBy(schema.invoice.createdAt);
}

// Inserts one draft invoice for an occurrence: the schedule's tax setup and
// fixed-amount lines, dated at the occurrence, due after its net terms, and
// covering the period up to (but not including) the following occurrence.
async function materialiseOccurrence(
  db: Db,
  schedule: ScheduleRow,
  lines: ScheduleLineRow[],
  occurrenceDate: Date,
  periodEnd: Date,
  standardRatePercent: string | undefined,
): Promise<string> {
  const totals = invoiceTotals({
    lineTotalsMinor: lines.map((l) => l.amountMinor),
    treatment: schedule.taxTreatment,
    standardRatePercent:
      schedule.taxTreatment === "standard" ? standardRatePercent : undefined,
  });
  const dueDate = new Date(
    occurrenceDate.getTime() + schedule.netTermsDays * MS_PER_DAY,
  );
  // Each retainer invoice starts with the client's default buyer reference,
  // like a hand-made draft.
  const [clientRow] = await db
    .select({ buyerReference: schema.client.buyerReference })
    .from(schema.client)
    .where(eq(schema.client.id, schedule.clientId));
  const [inv] = await db
    .insert(schema.invoice)
    .values({
      businessId: schedule.businessId,
      clientId: schedule.clientId,
      projectId: schedule.projectId,
      scheduleId: schedule.id,
      currency: schedule.currency,
      taxTreatment: schedule.taxTreatment,
      taxRatePercent: totals.taxRatePercent,
      taxNote: totals.taxNote,
      buyerReference: clientRow?.buyerReference ?? null,
      issueDate: occurrenceDate,
      dueDate,
      periodStart: occurrenceDate,
      periodEnd,
      notes: schedule.notes,
      subtotalMinor: totals.subtotalMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
    })
    .returning({ id: schema.invoice.id });
  if (lines.length > 0) {
    await db.insert(schema.invoiceLine).values(
      lines.map((line) => ({
        businessId: schedule.businessId,
        invoiceId: inv.id,
        position: line.position,
        description: line.description,
        quantity: null,
        unitPriceMinor: null,
        totalMinor: line.amountMinor,
      })),
    );
  }
  return inv.id;
}

type RunOutcome = {
  scheduleId: string;
  businessId: string;
  autoIssue: boolean;
  generatedInvoiceIds: string[];
};

// Generates every occurrence a schedule owes up to `now` (one, when called by
// generateNow with force), advancing next_run_at and applying stop conditions,
// all under a row lock. Draft creation only - auto-issue happens after commit.
async function runScheduleTransaction(
  db: Db,
  businessId: string,
  scheduleId: string,
  opts: { now: Date; force: boolean; max: number },
): Promise<RunOutcome | null> {
  return db.transaction(async (tx) => {
    const [schedule] = await tx
      .select()
      .from(schema.invoiceSchedule)
      .where(
        and(
          eq(schema.invoiceSchedule.businessId, businessId),
          eq(schema.invoiceSchedule.id, scheduleId),
        ),
      )
      .for("update");
    // Only active schedules generate. (Paused/ended never reach the sweep;
    // generateNow re-checks here so a stale click can't revive one.)
    if (!schedule || schedule.status !== "active") return null;

    const lines = await tx
      .select()
      .from(schema.invoiceScheduleLine)
      .where(eq(schema.invoiceScheduleLine.scheduleId, scheduleId))
      .orderBy(asc(schema.invoiceScheduleLine.position));
    const standardRatePercent =
      schedule.taxTreatment === "standard"
        ? await standardRatePercentFor(tx, businessId)
        : undefined;

    const cadence = cadenceOf(schedule);
    const generatedInvoiceIds: string[] = [];
    let nextRunAt = schedule.nextRunAt;
    let count = schedule.generatedCount;
    let status: ScheduleRow["status"] = schedule.status;

    for (let i = 0; i < opts.max; i += 1) {
      if (schedule.endDate && nextRunAt > schedule.endDate) {
        status = "ended";
        break;
      }
      if (schedule.occurrenceLimit != null && count >= schedule.occurrenceLimit) {
        status = "ended";
        break;
      }
      // The sweep only bills what is actually due; generateNow forces the next
      // one regardless.
      if (!opts.force && nextRunAt > opts.now) break;

      const following = nextOccurrence(nextRunAt, cadence);
      const periodEnd = new Date(following.getTime() - MS_PER_DAY);
      const invoiceId = await materialiseOccurrence(
        tx,
        schedule,
        lines,
        nextRunAt,
        periodEnd,
        standardRatePercent,
      );
      generatedInvoiceIds.push(invoiceId);
      count += 1;
      nextRunAt = following;

      if (schedule.occurrenceLimit != null && count >= schedule.occurrenceLimit) {
        status = "ended";
        break;
      }
      if (schedule.endDate && nextRunAt > schedule.endDate) {
        status = "ended";
        break;
      }
      // generateNow only ever produces one.
      if (opts.force) break;
    }

    await tx
      .update(schema.invoiceSchedule)
      .set({
        nextRunAt,
        generatedCount: count,
        status,
        lastRunAt: opts.now,
        lastError: null,
        updatedAt: opts.now,
      })
      .where(eq(schema.invoiceSchedule.id, scheduleId));

    return {
      scheduleId,
      businessId,
      autoIssue: schedule.autoIssue,
      generatedInvoiceIds,
    };
  });
}

// Records a run failure on the schedule without disturbing its position, so a
// bad schedule is loud (surfaced in its page) and the sweep can move on to the
// rest. Best-effort: never throws.
async function recordScheduleError(
  db: Db,
  scheduleId: string,
  message: string,
  now: Date,
): Promise<void> {
  try {
    await db
      .update(schema.invoiceSchedule)
      .set({ lastError: message, lastRunAt: now, updatedAt: now })
      .where(eq(schema.invoiceSchedule.id, scheduleId));
  } catch {
    // If even the error write fails the tick still continues; the next run
    // will try again.
  }
}

// Issues the drafts a run produced when the schedule is set to auto-issue.
// Best-effort per invoice: a refusal (e.g. reverse-charge missing a VAT
// number) leaves that invoice as a draft to review and is reported back so the
// schedule can flag it - the rest still issue.
async function autoIssueGenerated(
  db: Db,
  outcome: RunOutcome,
): Promise<string | null> {
  let firstProblem: string | null = null;
  for (const invoiceId of outcome.generatedInvoiceIds) {
    const result = await issueInvoice(db, outcome.businessId, invoiceId);
    if (!result.ok && firstProblem === null) {
      firstProblem =
        result.reason === "missing_vat_numbers"
          ? "Couldn't auto-issue: add both VAT numbers for reverse-charge invoices. Left as a draft."
          : "Couldn't auto-issue a generated invoice. Left as a draft.";
    }
  }
  return firstProblem;
}

export type RunSummary = {
  schedulesRun: number;
  invoicesGenerated: number;
  invoicesIssued: number;
  errors: number;
};

// The sweep: every active schedule whose next run is due, materialised and
// (when configured) auto-issued. Cross-tenant on purpose - it is the one
// system actor, called by the in-process scheduler and the cron endpoint.
export async function runDueSchedules(
  db: Db,
  now: Date = new Date(),
): Promise<RunSummary> {
  const due = await db
    .select({
      id: schema.invoiceSchedule.id,
      businessId: schema.invoiceSchedule.businessId,
    })
    .from(schema.invoiceSchedule)
    .where(
      and(
        eq(schema.invoiceSchedule.status, "active"),
        lte(schema.invoiceSchedule.nextRunAt, now),
      ),
    );

  const summary: RunSummary = {
    schedulesRun: 0,
    invoicesGenerated: 0,
    invoicesIssued: 0,
    errors: 0,
  };

  for (const row of due) {
    try {
      const outcome = await runScheduleTransaction(db, row.businessId, row.id, {
        now,
        force: false,
        max: MAX_CATCHUP_PER_RUN,
      });
      if (!outcome || outcome.generatedInvoiceIds.length === 0) continue;
      summary.schedulesRun += 1;
      summary.invoicesGenerated += outcome.generatedInvoiceIds.length;
      if (outcome.autoIssue) {
        const problem = await autoIssueGenerated(db, outcome);
        summary.invoicesIssued += outcome.generatedInvoiceIds.length;
        if (problem) {
          summary.errors += 1;
          await recordScheduleError(db, row.id, problem, now);
        }
      }
    } catch (err) {
      summary.errors += 1;
      await recordScheduleError(
        db,
        row.id,
        err instanceof Error ? err.message : "Generation failed",
        now,
      );
    }
  }

  return summary;
}

// Generates the next scheduled invoice immediately from the schedule page,
// without waiting for the sweep. One occurrence, dated at the pending
// next_run_at, then next_run_at advances as usual. Returns the outcome, or
// null when the schedule is missing/not active for this business.
export async function generateNow(
  db: Db,
  businessId: string,
  scheduleId: string,
  now: Date = new Date(),
): Promise<{ generated: number; issued: boolean; error: string | null } | null> {
  const outcome = await runScheduleTransaction(db, businessId, scheduleId, {
    now,
    force: true,
    max: 1,
  });
  if (!outcome) return null;
  let error: string | null = null;
  let issued = false;
  if (outcome.autoIssue && outcome.generatedInvoiceIds.length > 0) {
    error = await autoIssueGenerated(db, outcome);
    issued = true;
    if (error) {
      await recordScheduleError(db, scheduleId, error, now);
    }
  }
  return { generated: outcome.generatedInvoiceIds.length, issued, error };
}
