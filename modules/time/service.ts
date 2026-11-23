import { and, asc, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";
import { toEffectiveHourlyMinor } from "@/modules/billing/money";

// Time tracking. Tenancy contract as everywhere: businessId scopes every
// query. Durations are exact seconds (billing spec Section 7). Rates are
// resolved once, at entry creation, with the precedence
// (manual entry rate > client-member rate > project default > client default)
// and stored with their currency. A day rate is divided by the business
// hoursPerDay into an effective hourly rate at this point - the rest of the
// money model works in seconds x hourly rate. The internal cost of the worker
// (for profit tracking) is resolved and frozen here the same way. How a stored
// rate currency interacts with a different invoice currency is owned by the
// billing module - this module only records data.

export const manualEntrySchema = z.object({
  taskId: z.string().uuid(),
  startedAt: z.date(),
  durationSeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600),
  billable: z.boolean().default(true),
  note: z.string().trim().max(10_000).optional(),
  // Manual override; when absent the project/client default applies.
  rateMinor: z.number().int().nonnegative().nullable().optional(),
  rateCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
});

export type ManualEntryInput = z.infer<typeof manualEntrySchema>;

type RateUnit = "hour" | "day";

type TaskScope = {
  taskId: string;
  clientId: string;
  hoursPerDay: number;
  projectRateMinor: number | null;
  projectRateCurrency: string | null;
  projectRateUnit: RateUnit;
  clientRateMinor: number | null;
  clientRateCurrency: string | null;
  clientRateUnit: RateUnit;
};

type MemberRate = {
  billRateMinor: number;
  billRateCurrency: string;
  billRateUnit: RateUnit;
  internalCostMinor: number | null;
  internalCostCurrency: string | null;
  internalCostUnit: RateUnit;
};

type ResolvedRate = {
  rateMinor: number | null;
  rateCurrency: string | null;
  internalCostMinor: number | null;
  internalCostCurrency: string | null;
};

async function taskInBusiness(
  db: Db,
  businessId: string,
  taskId: string,
): Promise<TaskScope | null> {
  const [row] = await db
    .select({
      taskId: schema.task.id,
      clientId: schema.client.id,
      hoursPerDay: schema.business.hoursPerDay,
      projectRateMinor: schema.project.defaultRateMinor,
      projectRateCurrency: schema.project.defaultRateCurrency,
      projectRateUnit: schema.project.defaultRateUnit,
      clientRateMinor: schema.client.defaultRateMinor,
      clientRateCurrency: schema.client.defaultRateCurrency,
      clientRateUnit: schema.client.defaultRateUnit,
    })
    .from(schema.task)
    .innerJoin(schema.project, eq(schema.task.projectId, schema.project.id))
    .innerJoin(schema.client, eq(schema.project.clientId, schema.client.id))
    .innerJoin(schema.business, eq(schema.task.businessId, schema.business.id))
    .where(
      and(eq(schema.task.businessId, businessId), eq(schema.task.id, taskId)),
    );
  return row ?? null;
}

// The acting user's rate on this client, if one has been set.
async function memberRateForClient(
  db: Db,
  businessId: string,
  clientId: string,
  userId: string,
): Promise<MemberRate | null> {
  const [row] = await db
    .select({
      billRateMinor: schema.clientMemberRate.billRateMinor,
      billRateCurrency: schema.clientMemberRate.billRateCurrency,
      billRateUnit: schema.clientMemberRate.billRateUnit,
      internalCostMinor: schema.clientMemberRate.internalCostMinor,
      internalCostCurrency: schema.clientMemberRate.internalCostCurrency,
      internalCostUnit: schema.clientMemberRate.internalCostUnit,
    })
    .from(schema.clientMemberRate)
    .where(
      and(
        eq(schema.clientMemberRate.businessId, businessId),
        eq(schema.clientMemberRate.clientId, clientId),
        eq(schema.clientMemberRate.userId, userId),
      ),
    );
  return row ?? null;
}

// The member's effective hourly internal cost, or null when none is set.
// Resolved wherever a member rate applies, including under a manual bill-rate
// override (the override changes what's billed, not what the worker costs).
function memberInternalCost(
  member: MemberRate | null,
  hoursPerDay: number,
): { internalCostMinor: number | null; internalCostCurrency: string | null } {
  if (member && member.internalCostMinor != null && member.internalCostCurrency) {
    return {
      internalCostMinor: toEffectiveHourlyMinor(
        member.internalCostMinor,
        member.internalCostUnit,
        hoursPerDay,
      ),
      internalCostCurrency: member.internalCostCurrency,
    };
  }
  return { internalCostMinor: null, internalCostCurrency: null };
}

// Resolution precedence: manual entry rate > client-member rate (for the
// acting user) > project default > client default. A day rate at any level is
// converted to an effective hourly rate once, here. The internal cost always
// comes from the member row (it doesn't move with a manual bill override).
function resolveRateAndCost(
  scope: TaskScope,
  member: MemberRate | null,
  manual: { rateMinor?: number | null; rateCurrency?: string | null },
): ResolvedRate {
  const cost = memberInternalCost(member, scope.hoursPerDay);

  if (manual.rateMinor != null && manual.rateCurrency) {
    return {
      rateMinor: manual.rateMinor,
      rateCurrency: manual.rateCurrency,
      ...cost,
    };
  }
  if (member) {
    return {
      rateMinor: toEffectiveHourlyMinor(
        member.billRateMinor,
        member.billRateUnit,
        scope.hoursPerDay,
      ),
      rateCurrency: member.billRateCurrency,
      ...cost,
    };
  }
  if (scope.projectRateMinor != null && scope.projectRateCurrency) {
    return {
      rateMinor: toEffectiveHourlyMinor(
        scope.projectRateMinor,
        scope.projectRateUnit,
        scope.hoursPerDay,
      ),
      rateCurrency: scope.projectRateCurrency,
      ...cost,
    };
  }
  if (scope.clientRateMinor != null && scope.clientRateCurrency) {
    return {
      rateMinor: toEffectiveHourlyMinor(
        scope.clientRateMinor,
        scope.clientRateUnit,
        scope.hoursPerDay,
      ),
      rateCurrency: scope.clientRateCurrency,
      ...cost,
    };
  }
  return {
    rateMinor: null,
    rateCurrency: null,
    ...cost,
  };
}

export async function getRunningTimer(db: Db, businessId: string, userId: string) {
  const [row] = await db
    .select({
      id: schema.timeEntry.id,
      taskId: schema.timeEntry.taskId,
      startedAt: schema.timeEntry.startedAt,
      taskTitle: schema.task.title,
      projectId: schema.task.projectId,
    })
    .from(schema.timeEntry)
    .innerJoin(schema.task, eq(schema.timeEntry.taskId, schema.task.id))
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.userId, userId),
        isNull(schema.timeEntry.endedAt),
      ),
    );
  return row ?? null;
}

// Starting a timer stops any running one first (one active task per user,
// like the design kit's board) - switching tasks must never lose time.
export async function startTimer(
  db: Db,
  businessId: string,
  userId: string,
  taskId: string,
) {
  const scope = await taskInBusiness(db, businessId, taskId);
  if (!scope) {
    return null;
  }
  const member = await memberRateForClient(db, businessId, scope.clientId, userId);
  return db.transaction(async (tx) => {
    await stopTimerTx(tx, businessId, userId);
    const rate = resolveRateAndCost(scope, member, {});
    const [created] = await tx
      .insert(schema.timeEntry)
      .values({
        businessId,
        taskId,
        userId,
        startedAt: new Date(),
        billable: true,
        rateMinor: rate.rateMinor,
        rateCurrency: rate.rateCurrency,
        internalCostMinor: rate.internalCostMinor,
        internalCostCurrency: rate.internalCostCurrency,
      })
      .returning();
    return created;
  });
}

async function stopTimerTx(db: Db, businessId: string, userId: string) {
  const [running] = await db
    .select()
    .from(schema.timeEntry)
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.userId, userId),
        isNull(schema.timeEntry.endedAt),
      ),
    );
  if (!running) {
    return null;
  }
  const endedAt = new Date();
  const durationSeconds = Math.max(
    1,
    Math.round((endedAt.getTime() - running.startedAt.getTime()) / 1000),
  );
  const [stopped] = await db
    .update(schema.timeEntry)
    .set({ endedAt, durationSeconds, updatedAt: endedAt })
    .where(eq(schema.timeEntry.id, running.id))
    .returning();
  return stopped;
}

export async function stopTimer(db: Db, businessId: string, userId: string) {
  return stopTimerTx(db, businessId, userId);
}

export async function logManualEntry(
  db: Db,
  businessId: string,
  userId: string,
  input: ManualEntryInput,
) {
  const scope = await taskInBusiness(db, businessId, input.taskId);
  if (!scope) {
    return null;
  }
  const member = await memberRateForClient(
    db,
    businessId,
    scope.clientId,
    userId,
  );
  const rate = resolveRateAndCost(scope, member, {
    rateMinor: input.rateMinor,
    rateCurrency: input.rateCurrency,
  });
  const endedAt = new Date(
    input.startedAt.getTime() + input.durationSeconds * 1000,
  );
  const [created] = await db
    .insert(schema.timeEntry)
    .values({
      businessId,
      taskId: input.taskId,
      userId,
      startedAt: input.startedAt,
      endedAt,
      durationSeconds: input.durationSeconds,
      billable: input.billable,
      note: input.note ?? null,
      rateMinor: rate.rateMinor,
      rateCurrency: rate.rateCurrency,
      internalCostMinor: rate.internalCostMinor,
      internalCostCurrency: rate.internalCostCurrency,
    })
    .returning();
  return created;
}

export async function listEntriesForTask(
  db: Db,
  businessId: string,
  taskId: string,
) {
  return db
    .select()
    .from(schema.timeEntry)
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.taskId, taskId),
      ),
    )
    .orderBy(desc(schema.timeEntry.startedAt));
}

// Closed entries for one user in [from, to), joined with task/project/
// client names for the timesheet. Running timers are excluded - they
// appear once stopped.
export async function listEntriesBetween(
  db: Db,
  businessId: string,
  userId: string,
  from: Date,
  to: Date,
) {
  return db
    .select({
      id: schema.timeEntry.id,
      startedAt: schema.timeEntry.startedAt,
      durationSeconds: schema.timeEntry.durationSeconds,
      billable: schema.timeEntry.billable,
      note: schema.timeEntry.note,
      taskId: schema.timeEntry.taskId,
      taskTitle: schema.task.title,
      projectId: schema.task.projectId,
      projectName: schema.project.name,
      clientName: schema.client.name,
    })
    .from(schema.timeEntry)
    .innerJoin(schema.task, eq(schema.timeEntry.taskId, schema.task.id))
    .innerJoin(schema.project, eq(schema.task.projectId, schema.project.id))
    .innerJoin(schema.client, eq(schema.project.clientId, schema.client.id))
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.userId, userId),
        isNotNull(schema.timeEntry.endedAt),
        gte(schema.timeEntry.startedAt, from),
        lt(schema.timeEntry.startedAt, to),
      ),
    )
    .orderBy(asc(schema.timeEntry.startedAt));
}

// Notes on entries ("during this time I did X") - editable after the
// fact, on timer entries and manual ones alike.
export async function updateEntryNote(
  db: Db,
  businessId: string,
  entryId: string,
  note: string | null,
) {
  const [updated] = await db
    .update(schema.timeEntry)
    .set({ note, updatedAt: new Date() })
    .where(
      and(
        eq(schema.timeEntry.businessId, businessId),
        eq(schema.timeEntry.id, entryId),
      ),
    )
    .returning();
  return updated ?? null;
}

// Deleting an entry (#5584): `ownerId` set = the caller may only delete
// their own entries (no time.viewAll), and someone else's looks missing.
// Billed time (on an invoice line) is never deleted: remove the line first,
// which returns the entry to the unbilled pool.
export async function deleteEntry(
  db: Db,
  businessId: string,
  entryId: string,
  opts: { ownerId?: string } = {},
) {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: schema.timeEntry.id, invoiceLineId: schema.timeEntry.invoiceLineId })
      .from(schema.timeEntry)
      .where(
        and(
          eq(schema.timeEntry.businessId, businessId),
          eq(schema.timeEntry.id, entryId),
          opts.ownerId ? eq(schema.timeEntry.userId, opts.ownerId) : undefined,
        ),
      )
      .for("update");
    if (!entry) return null;
    if (entry.invoiceLineId) return "billed" as const;
    const [deleted] = await tx
      .delete(schema.timeEntry)
      .where(eq(schema.timeEntry.id, entry.id))
      .returning();
    return deleted ?? null;
  });
}
