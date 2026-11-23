// Invoice-from-time (billing spec Section 7 + ESC-5 resolution).
// The grouping core is a pure function over entry data so every money
// path is fixture-testable; the db wrapper links entries to the lines it
// creates and recomputes invoice totals in the same transaction.

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";

import {
  FIXED_LINE_UNIT,
  TIME_LINE_UNIT,
  type UnitCode,
} from "@/lib/einvoice-codes";

import { majorToMinor, minorToMajor } from "./currency";
import {
  convertMinor,
  lineTotalMinorFromSeconds,
  parseDecimal,
} from "./money";
import { invoiceTotals } from "./tax";

export type GroupingMode = "person_rate" | "task" | "single";

export type BillableEntry = {
  id: string;
  userId: string;
  userName: string;
  taskId: string;
  taskTitle: string;
  durationSeconds: number;
  rateMinor: number | null;
  rateCurrency: string | null;
  // The timesheet note; listed on the line when includeNotes is set.
  note?: string | null;
};

export type FxRateInput = { rate: string; source: "ecb" | "manual" };

export type GeneratedLine = {
  description: string;
  // Display-only decimal hours (6dp); the authoritative quantity is the
  // exact seconds carried by the linked entries.
  quantity: string;
  unitPriceMinor: number;
  totalMinor: number;
  sourceCurrency: string | null;
  sourceTotalMinor: number | null;
  fxRate: string | null;
  fxSource: "ecb" | "manual" | null;
  entryIds: string[];
};

export type GroupingResult =
  | {
      ok: true;
      lines: GeneratedLine[];
      // Billable entries that could not be priced (no stored rate) - they
      // stay unbilled and the UI surfaces them; never silently dropped.
      unpricedEntryIds: string[];
    }
  | { ok: false; reason: "missing_fx_rates"; currencies: string[] }
  | { ok: false; reason: "mixed_rates_for_single_line" }
  | { ok: false; reason: "nothing_to_bill" };

function hoursDisplay(seconds: number): string {
  // 6 decimal places: enough that display x rate reproduces the exact
  // total after rounding for any duration under a year.
  const whole = Math.floor(seconds / 3600);
  const rem = seconds % 3600;
  const fraction = Math.round((rem / 3600) * 1e6);
  return `${whole}.${String(fraction).padStart(6, "0")}`;
}

function priceLine(
  totalSeconds: number,
  rateMinor: number,
  rateCurrency: string,
  invoiceCurrency: string,
  fxRates: Record<string, FxRateInput>,
): Omit<GeneratedLine, "description" | "entryIds"> {
  // Rounding point 1: the line total in the rate's own currency.
  const sourceTotal = lineTotalMinorFromSeconds(totalSeconds, rateMinor);
  if (rateCurrency === invoiceCurrency) {
    return {
      quantity: hoursDisplay(totalSeconds),
      unitPriceMinor: rateMinor,
      totalMinor: sourceTotal,
      sourceCurrency: null,
      sourceTotalMinor: null,
      fxRate: null,
      fxSource: null,
    };
  }
  // Rounding point 3: one conversion of the line total (ESC-5).
  const fx = fxRates[rateCurrency];
  const totalMinor = convertMinor(
    sourceTotal,
    fx.rate,
    rateCurrency,
    invoiceCurrency,
  );
  return {
    quantity: hoursDisplay(totalSeconds),
    // The converted unit price is informational; the total is what was
    // converted (converting the total once, not the rate, per the spec).
    unitPriceMinor: convertMinor(rateMinor, fx.rate, rateCurrency, invoiceCurrency),
    totalMinor,
    sourceCurrency: rateCurrency,
    sourceTotalMinor: sourceTotal,
    fxRate: fx.rate,
    fxSource: fx.source,
  };
}

// The timesheet notes behind one line, one "- " line each, in the order
// the entries arrive (the db wrapper sorts them by start time). A
// multi-line note gives one line per non-blank row; repeats are listed
// once. When the line covers several tasks each note names its task, so
// the client can tell which work it belongs to.
function noteLines(entries: BillableEntry[]): string[] {
  const severalTasks = new Set(entries.map((e) => e.taskId)).size > 1;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    for (const row of (entry.note ?? "").split(/\r?\n/)) {
      const text = row.trim();
      const line = severalTasks ? `${entry.taskTitle}: ${text}` : text;
      if (text === "" || seen.has(line)) {
        continue;
      }
      seen.add(line);
      lines.push(`- ${line}`);
    }
  }
  return lines;
}

export function groupTimeEntriesToLines(input: {
  entries: BillableEntry[];
  grouping: GroupingMode;
  invoiceCurrency: string;
  fxRates?: Record<string, FxRateInput>;
  includeTaskList?: boolean;
  includeNotes?: boolean;
}): GroupingResult {
  const fxRates = input.fxRates ?? {};
  const priced = input.entries.filter(
    (e) => e.rateMinor !== null && e.rateCurrency !== null,
  );
  const unpricedEntryIds = input.entries
    .filter((e) => e.rateMinor === null || e.rateCurrency === null)
    .map((e) => e.id);

  if (priced.length === 0) {
    return { ok: false, reason: "nothing_to_bill" };
  }

  // Every foreign rate currency needs an FX rate before any math runs.
  const foreign = [
    ...new Set(
      priced
        .map((e) => e.rateCurrency as string)
        .filter((c) => c !== input.invoiceCurrency),
    ),
  ];
  const missing = foreign.filter((c) => !fxRates[c]);
  if (missing.length > 0) {
    return { ok: false, reason: "missing_fx_rates", currencies: missing };
  }

  // Validate FX rate strings up front - a malformed rate must fail loud
  // before anything is computed.
  for (const c of foreign) {
    parseDecimal(fxRates[c].rate);
  }

  type Group = { key: string; description: string; entries: BillableEntry[] };
  let groups: Group[];

  if (input.grouping === "single") {
    const rateKeys = new Set(
      priced.map((e) => `${e.rateMinor}:${e.rateCurrency}`),
    );
    if (rateKeys.size > 1) {
      // Spec: single line is only offered when all entries share one rate.
      return { ok: false, reason: "mixed_rates_for_single_line" };
    }
    groups = [{ key: "single", description: "Tracked time", entries: priced }];
  } else if (input.grouping === "task") {
    // Per task, sub-split when manual overrides created mixed rates
    // within one task (each line still has exactly one rate).
    const map = new Map<string, Group>();
    for (const e of priced) {
      const key = `${e.taskId}:${e.rateMinor}:${e.rateCurrency}`;
      const group = map.get(key) ?? {
        key,
        description: e.taskTitle,
        entries: [],
      };
      group.entries.push(e);
      map.set(key, group);
    }
    groups = [...map.values()];
  } else {
    // person_rate (Shay's preferred mode): one line per person + rate.
    const map = new Map<string, Group>();
    for (const e of priced) {
      const key = `${e.userId}:${e.rateMinor}:${e.rateCurrency}`;
      const rate = `${minorToMajor(e.rateMinor as number, e.rateCurrency as string)} ${e.rateCurrency}/h`;
      const group = map.get(key) ?? {
        key,
        description: `${e.userName} - ${rate}`,
        entries: [],
      };
      group.entries.push(e);
      map.set(key, group);
    }
    groups = [...map.values()];
  }

  const lines: GeneratedLine[] = groups.map((group) => {
    const totalSeconds = group.entries.reduce(
      (sum, e) => sum + e.durationSeconds,
      0,
    );
    const first = group.entries[0];
    const taskList = [
      ...new Set(group.entries.map((e) => e.taskTitle)),
    ].sort();
    const heading =
      input.includeTaskList && input.grouping !== "task"
        ? `${group.description} (${taskList.join(", ")})`
        : group.description;
    const notes = input.includeNotes ? noteLines(group.entries) : [];
    return {
      description: [heading, ...notes].join("\n"),
      entryIds: group.entries.map((e) => e.id),
      ...priceLine(
        totalSeconds,
        first.rateMinor as number,
        first.rateCurrency as string,
        input.invoiceCurrency,
        fxRates,
      ),
    };
  });

  return { ok: true, lines, unpricedEntryIds };
}

// Recomputes invoice totals from its current lines through the tax
// engine. Always called inside the same transaction as a line change.
export async function recomputeInvoiceTotals(
  db: Db,
  businessId: string,
  invoiceId: string,
) {
  const [inv] = await db
    .select()
    .from(schema.invoice)
    .where(
      and(
        eq(schema.invoice.businessId, businessId),
        eq(schema.invoice.id, invoiceId),
      ),
    );
  if (!inv) {
    return null;
  }
  const lines = await db
    .select({ totalMinor: schema.invoiceLine.totalMinor })
    .from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, invoiceId));
  const totals = invoiceTotals({
    lineTotalsMinor: lines.map((l) => l.totalMinor),
    treatment: inv.taxTreatment,
    standardRatePercent:
      inv.taxTreatment === "standard" ? inv.taxRatePercent : undefined,
  });
  const [updated] = await db
    .update(schema.invoice)
    .set({
      subtotalMinor: totals.subtotalMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      updatedAt: new Date(),
    })
    .where(eq(schema.invoice.id, invoiceId))
    .returning();
  return updated;
}

// Why a generation found nothing to bill: how the client's entries are
// distributed over the states that exclude them from the unbilled pool.
// Surfaced with every nothing_to_bill result so "no lines" is never a
// mystery - the counts name the fix (delete/void the holding invoice, set
// a rate, stop a timer).
export type NothingToBillDetails = {
  // Billable, closed, unbilled entries with no stored rate.
  unpriced: number;
  // Billable entries whose timer has not been stopped yet.
  running: number;
  nonBillable: number;
  // Entries already linked to invoice lines, grouped by holding invoice.
  alreadyBilled: {
    invoiceId: string;
    number: string | null;
    status: string;
    entries: number;
  }[];
};

async function describeNothingToBill(
  db: Db,
  businessId: string,
  clientId: string,
  projectId?: string,
): Promise<NothingToBillDetails> {
  const scope = [
    eq(schema.timeEntry.businessId, businessId),
    eq(schema.project.clientId, clientId),
  ];
  if (projectId) {
    scope.push(eq(schema.project.id, projectId));
  }
  const rows = await db
    .select({
      billable: schema.timeEntry.billable,
      endedAt: schema.timeEntry.endedAt,
      rateMinor: schema.timeEntry.rateMinor,
      rateCurrency: schema.timeEntry.rateCurrency,
      invoiceId: schema.invoice.id,
      invoiceNumber: schema.invoice.number,
      invoiceStatus: schema.invoice.status,
    })
    .from(schema.timeEntry)
    .innerJoin(schema.task, eq(schema.timeEntry.taskId, schema.task.id))
    .innerJoin(schema.project, eq(schema.task.projectId, schema.project.id))
    .leftJoin(
      schema.invoiceLine,
      eq(schema.timeEntry.invoiceLineId, schema.invoiceLine.id),
    )
    .leftJoin(
      schema.invoice,
      eq(schema.invoiceLine.invoiceId, schema.invoice.id),
    )
    .where(and(...scope));

  const details: NothingToBillDetails = {
    unpriced: 0,
    running: 0,
    nonBillable: 0,
    alreadyBilled: [],
  };
  const byInvoice = new Map<string, NothingToBillDetails["alreadyBilled"][number]>();
  for (const row of rows) {
    if (row.invoiceId) {
      const bucket = byInvoice.get(row.invoiceId) ?? {
        invoiceId: row.invoiceId,
        number: row.invoiceNumber,
        status: row.invoiceStatus as string,
        entries: 0,
      };
      bucket.entries += 1;
      byInvoice.set(row.invoiceId, bucket);
    } else if (!row.billable) {
      details.nonBillable += 1;
    } else if (row.endedAt === null) {
      details.running += 1;
    } else if (row.rateMinor === null || row.rateCurrency === null) {
      details.unpriced += 1;
    }
  }
  details.alreadyBilled = [...byInvoice.values()].sort(
    (a, b) => b.entries - a.entries,
  );
  return details;
}

// Pulls the client's unbilled, billable, closed entries (optionally one
// project's), runs the grouping core, and writes lines + entry links +
// totals in one transaction onto an existing draft invoice. With
// `replace`, the draft's previously generated lines are cleared and their
// time re-pooled first (so a wrong grouping choice is a regenerate away,
// not a dead end) - manual fixed-amount lines are never touched. The line
// insert and entry linking are batched: one statement each, so a large
// generation commits in a handful of round trips instead of two per line.
export async function generateLinesFromUnbilledTime(
  db: Db,
  businessId: string,
  input: {
    invoiceId: string;
    projectId?: string;
    grouping: GroupingMode;
    fxRates?: Record<string, FxRateInput>;
    includeTaskList?: boolean;
    includeNotes?: boolean;
    replace?: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, input.invoiceId),
        ),
      )
      .for("update");
    if (!inv || inv.status !== "draft") {
      return { ok: false as const, reason: "no_draft" as const };
    }

    const scope = [
      eq(schema.timeEntry.businessId, businessId),
      eq(schema.project.clientId, inv.clientId),
      eq(schema.timeEntry.billable, true),
      // In replace mode, time billed on this draft's own lines counts as
      // available again - the pool is validated before anything is deleted,
      // so a failed grouping never destroys the existing lines.
      input.replace
        ? or(
            isNull(schema.timeEntry.invoiceLineId),
            inArray(
              schema.timeEntry.invoiceLineId,
              tx
                .select({ id: schema.invoiceLine.id })
                .from(schema.invoiceLine)
                .where(eq(schema.invoiceLine.invoiceId, inv.id)),
            ),
          )!
        : isNull(schema.timeEntry.invoiceLineId),
      isNotNull(schema.timeEntry.endedAt),
    ];
    if (input.projectId) {
      scope.push(eq(schema.project.id, input.projectId));
    }
    const rows = await tx
      .select({
        id: schema.timeEntry.id,
        userId: schema.timeEntry.userId,
        userName: schema.user.name,
        taskId: schema.timeEntry.taskId,
        taskTitle: schema.task.title,
        durationSeconds: schema.timeEntry.durationSeconds,
        rateMinor: schema.timeEntry.rateMinor,
        rateCurrency: schema.timeEntry.rateCurrency,
        note: schema.timeEntry.note,
      })
      .from(schema.timeEntry)
      .innerJoin(schema.task, eq(schema.timeEntry.taskId, schema.task.id))
      .innerJoin(schema.project, eq(schema.task.projectId, schema.project.id))
      .innerJoin(schema.user, eq(schema.timeEntry.userId, schema.user.id))
      .where(and(...scope))
      // Logged order, so listed notes read as the work happened.
      .orderBy(asc(schema.timeEntry.startedAt), asc(schema.timeEntry.id));

    const result = groupTimeEntriesToLines({
      entries: rows.map((r) => ({
        ...r,
        durationSeconds: r.durationSeconds ?? 0,
      })),
      grouping: input.grouping,
      invoiceCurrency: inv.currency,
      fxRates: input.fxRates,
      includeTaskList: input.includeTaskList,
      includeNotes: input.includeNotes,
    });
    if (!result.ok) {
      if (result.reason === "nothing_to_bill") {
        return {
          ...result,
          details: await describeNothingToBill(
            tx,
            businessId,
            inv.clientId,
            input.projectId,
          ),
        };
      }
      return result;
    }

    if (input.replace) {
      // Clear this draft's generated lines: still-linked ones (their entries
      // are re-pooled by the FK's SET NULL and immediately re-linked below)
      // and orphaned time-backed leftovers whose entries no longer exist.
      await tx.delete(schema.invoiceLine).where(
        and(
          eq(schema.invoiceLine.invoiceId, inv.id),
          or(
            isNotNull(schema.invoiceLine.quantity),
            exists(
              tx
                .select({ one: sql`1` })
                .from(schema.timeEntry)
                .where(
                  eq(schema.timeEntry.invoiceLineId, schema.invoiceLine.id),
                ),
            ),
          ),
        ),
      );
    }

    const [{ maxPosition }] = await tx
      .select({ maxPosition: max(schema.invoiceLine.position) })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, inv.id));

    const basePosition = Number(maxPosition ?? 0);
    const created = await tx
      .insert(schema.invoiceLine)
      .values(
        result.lines.map((line, i) => ({
          businessId,
          invoiceId: inv.id,
          position: basePosition + i + 1,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalMinor: line.totalMinor,
          unitCode: TIME_LINE_UNIT,
          sourceCurrency: line.sourceCurrency,
          sourceTotalMinor: line.sourceTotalMinor,
          fxRate: line.fxRate,
          fxSource: line.fxSource,
        })),
      )
      .returning({
        id: schema.invoiceLine.id,
        position: schema.invoiceLine.position,
      });
    // RETURNING order is not guaranteed; positions are unique within the
    // batch, so they map each created id back to its source line.
    const idByPosition = new Map(created.map((l) => [l.position, l.id]));

    const pairs: { entryId: string; lineId: string }[] = [];
    result.lines.forEach((line, i) => {
      const lineId = idByPosition.get(basePosition + i + 1);
      if (!lineId) {
        throw new Error("Generated line missing from insert result");
      }
      for (const entryId of line.entryIds) {
        pairs.push({ entryId, lineId });
      }
    });
    const values = sql.join(
      pairs.map((p) => sql`(${p.entryId}::uuid, ${p.lineId}::uuid)`),
      sql`, `,
    );
    await tx.execute(sql`
      update "time_entry" set
        "invoice_line_id" = m.line_id,
        "updated_at" = now()
      from (values ${values}) as m(entry_id, line_id)
      where "time_entry"."id" = m.entry_id
    `);

    await recomputeInvoiceTotals(tx, businessId, inv.id);
    return {
      ok: true as const,
      lineCount: result.lines.length,
      unpricedEntryIds: result.unpricedEntryIds,
    };
  });
}

// Manual fixed-amount line: invoices are dual-purpose, not only
// time-based. The amount arrives as a major-unit string in the invoice
// currency and is converted exactly (rejected, never rounded, when it has
// more decimals than the currency allows). No new rounding point: what
// the user typed is the line total.
export async function addManualLine(
  db: Db,
  businessId: string,
  input: {
    invoiceId: string;
    description: string;
    amountMajor: string;
    unitCode?: UnitCode;
  },
) {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select({
        id: schema.invoice.id,
        status: schema.invoice.status,
        currency: schema.invoice.currency,
      })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.businessId, businessId),
          eq(schema.invoice.id, input.invoiceId),
        ),
      )
      .for("update");
    if (!inv || inv.status !== "draft") {
      return { ok: false as const, reason: "no_draft" as const };
    }

    const totalMinor = majorToMinor(input.amountMajor, inv.currency);
    if (totalMinor === null) {
      return { ok: false as const, reason: "bad_amount" as const };
    }

    const [{ maxPosition }] = await tx
      .select({ maxPosition: max(schema.invoiceLine.position) })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, inv.id));

    await tx.insert(schema.invoiceLine).values({
      businessId,
      invoiceId: inv.id,
      position: Number(maxPosition ?? 0) + 1,
      description: input.description,
      quantity: null,
      unitPriceMinor: null,
      totalMinor,
      unitCode: input.unitCode ?? FIXED_LINE_UNIT,
    });

    const updated = await recomputeInvoiceTotals(tx, businessId, inv.id);
    return { ok: true as const, invoice: updated };
  });
}

// Editing a draft line in place. Draft-only, like every other line change.
// Description and amount are the editable surface. Changing the amount is a
// manual override: it supersedes any auto-derived hours x rate breakdown and
// FX conversion recorded on the line, so those are cleared - otherwise the
// line would show a "4.08 h x EUR 62/h" subtitle that no longer multiplies out
// to the total. A description-only edit (amount unchanged) leaves the breakdown
// - and the line's linked time entries - untouched. Returns { ok, invoice } or
// a reason, mirroring addManualLine.
export async function updateInvoiceLine(
  db: Db,
  businessId: string,
  input: {
    lineId: string;
    description: string;
    amountMajor: string;
    // Left out = keep, except that a changed amount turns the line into a
    // fixed amount (C62) along with dropping its hours x rate breakdown.
    unitCode?: UnitCode;
  },
) {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({
        id: schema.invoiceLine.id,
        invoiceId: schema.invoiceLine.invoiceId,
        totalMinor: schema.invoiceLine.totalMinor,
        status: schema.invoice.status,
        currency: schema.invoice.currency,
      })
      .from(schema.invoiceLine)
      .innerJoin(
        schema.invoice,
        eq(schema.invoiceLine.invoiceId, schema.invoice.id),
      )
      .where(
        and(
          eq(schema.invoiceLine.businessId, businessId),
          eq(schema.invoiceLine.id, input.lineId),
        ),
      )
      // Lock the invoice like issueInvoice does, so the draft check below
      // can't race an issue (#5584).
      .for("update", { of: schema.invoice });
    if (!line || line.status !== "draft") {
      return { ok: false as const, reason: "no_draft" as const };
    }

    const totalMinor = majorToMinor(input.amountMajor, line.currency);
    if (totalMinor === null) {
      return { ok: false as const, reason: "bad_amount" as const };
    }

    // A changed figure drops the now-inconsistent breakdown (see note above);
    // an unchanged one is a pure description edit and keeps it.
    const amountChanged = totalMinor !== line.totalMinor;
    await tx
      .update(schema.invoiceLine)
      .set({
        description: input.description,
        totalMinor,
        updatedAt: new Date(),
        ...(input.unitCode
          ? { unitCode: input.unitCode }
          : amountChanged
            ? { unitCode: FIXED_LINE_UNIT }
            : {}),
        ...(amountChanged
          ? {
              quantity: null,
              unitPriceMinor: null,
              sourceCurrency: null,
              sourceTotalMinor: null,
              fxRate: null,
              fxSource: null,
            }
          : {}),
      })
      .where(eq(schema.invoiceLine.id, line.id));

    const updated = await recomputeInvoiceTotals(tx, businessId, line.invoiceId);
    return { ok: true as const, invoice: updated };
  });
}

// Free-text notes printed at the foot of the invoice, just above the footer.
// Draft-only, like every other invoice edit; an empty/whitespace value clears
// them. Returns the updated invoice, or null when there is no draft to edit.
export async function setInvoiceNotes(
  db: Db,
  businessId: string,
  invoiceId: string,
  notes: string,
) {
  const trimmed = notes.trim();
  const [updated] = await db
    .update(schema.invoice)
    .set({ notes: trimmed || null, updatedAt: new Date() })
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

// Removing a draft line releases its entries back to the unbilled pool
// (the FK is ON DELETE SET NULL) and recomputes totals.
export async function deleteInvoiceLine(
  db: Db,
  businessId: string,
  lineId: string,
) {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({
        id: schema.invoiceLine.id,
        invoiceId: schema.invoiceLine.invoiceId,
        status: schema.invoice.status,
      })
      .from(schema.invoiceLine)
      .innerJoin(
        schema.invoice,
        eq(schema.invoiceLine.invoiceId, schema.invoice.id),
      )
      .where(
        and(
          eq(schema.invoiceLine.businessId, businessId),
          eq(schema.invoiceLine.id, lineId),
        ),
      )
      // Lock the invoice like issueInvoice does (#5584).
      .for("update", { of: schema.invoice });
    if (!line || line.status !== "draft") {
      return null;
    }
    await tx.delete(schema.invoiceLine).where(eq(schema.invoiceLine.id, line.id));
    return recomputeInvoiceTotals(tx, businessId, line.invoiceId);
  });
}
