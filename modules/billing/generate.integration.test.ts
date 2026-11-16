import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createClient } from "@/modules/clients/service";
import { createProject } from "@/modules/projects/service";
import { createTask } from "@/modules/projects/tasks-service";
import { logManualEntry } from "@/modules/time/service";
import { createTestDatabase } from "@/db/testing";

import {
  addManualLine,
  deleteInvoiceLine,
  generateLinesFromUnbilledTime,
  setInvoiceNotes,
  updateInvoiceLine,
} from "./generate";
import {
  createDraftInvoice,
  deleteDraftInvoice,
  issueInvoice,
} from "./invoices";
import { voidInvoice } from "./lifecycle";

let pglite: PGlite;
let db: Db;
let business: { id: string };
let client: { id: string };
let project: { id: string };
let task: { id: string };
const user = "user-a";

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());

  [business] = await db
    .insert(schema.business)
    .values({
      name: "Alpha Studio",
      currency: "EUR",
      taxConfig: { standardRatePct: "21" },
    })
    .returning();
  await db
    .insert(schema.user)
    .values([{ id: user, name: "Shay", email: "shay@alpha.test" }]);
  client = await createClient(db, business.id, user, {
    name: "Northwind",
    contacts: [],
    defaultRateMinor: 6200,
    defaultRateCurrency: "EUR",
  });
  project = (await createProject(db, business.id, user, {
    name: "Website",
    clientId: client.id,
    status: "active",
  })) as { id: string };
  task = (await createTask(db, business.id, project.id, {
    title: "Homepage build",
    status: "in_progress",
  })) as { id: string };

  // 2h15m + 1h50m billable (the spec example), one non-billable.
  await logManualEntry(db, business.id, user, {
    taskId: task.id,
    startedAt: new Date("2026-06-08T09:00:00Z"),
    durationSeconds: 8100,
    billable: true,
  });
  await logManualEntry(db, business.id, user, {
    taskId: task.id,
    startedAt: new Date("2026-06-09T09:00:00Z"),
    durationSeconds: 6600,
    billable: true,
  });
  await logManualEntry(db, business.id, user, {
    taskId: task.id,
    startedAt: new Date("2026-06-09T13:00:00Z"),
    durationSeconds: 3600,
    billable: false,
  });
});

afterAll(async () => {
  await pglite.close();
});

describe("generate lines from unbilled time (integration)", () => {
  it("creates lines, links entries, computes totals, and releases on line removal", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    expect(draft).not.toBeNull();
    const invoiceId = (draft as { id: string }).id;

    const generated = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    expect(generated).toMatchObject({ ok: true, lineCount: 1 });

    // Spec S7 example: 4h05m at EUR 62.00/h = 253.17 subtotal;
    // 21% of 25317 = 5316.57 -> 5317 tax (half-up); total 306.34.
    const [inv] = await db
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.id, invoiceId));
    expect(inv.subtotalMinor).toBe(25317);
    expect(inv.taxMinor).toBe(5317);
    expect(inv.totalMinor).toBe(30634);

    // The two billable entries are linked; the non-billable one is not.
    const linked = await db
      .select()
      .from(schema.timeEntry)
      .where(
        and(
          eq(schema.timeEntry.businessId, business.id),
          isNull(schema.timeEntry.invoiceLineId),
        ),
      );
    expect(linked).toHaveLength(1);
    expect(linked[0].billable).toBe(false);

    // A second generation finds nothing unbilled.
    const again = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    expect(again).toMatchObject({ ok: false, reason: "nothing_to_bill" });

    // Removing the draft line releases the entries and zeroes totals.
    const [line] = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    const afterDelete = await deleteInvoiceLine(db, business.id, line.id);
    expect(afterDelete?.subtotalMinor).toBe(0);
    expect(afterDelete?.totalMinor).toBe(0);

    const released = await db
      .select()
      .from(schema.timeEntry)
      .where(
        and(
          eq(schema.timeEntry.businessId, business.id),
          isNull(schema.timeEntry.invoiceLineId),
        ),
      );
    expect(released).toHaveLength(3);
  });

  it("supports fixed-amount manual lines alongside generated ones", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;

    // Exact amount in: EUR 1,500.00 -> 150000 minor, taxed on the subtotal.
    const added = await addManualLine(db, business.id, {
      invoiceId,
      description: "Discovery workshop (fixed fee)",
      amountMajor: "1500",
    });
    expect(added).toMatchObject({ ok: true });
    if (added.ok) {
      expect(added.invoice?.subtotalMinor).toBe(150000);
      expect(added.invoice?.taxMinor).toBe(31500);
      expect(added.invoice?.totalMinor).toBe(181500);
    }

    // More decimals than the currency allows is rejected, never rounded.
    const rejected = await addManualLine(db, business.id, {
      invoiceId,
      description: "Bad amount",
      amountMajor: "10.005",
    });
    expect(rejected).toMatchObject({ ok: false, reason: "bad_amount" });

    // Manual lines coexist with generated ones; totals stay one pipeline.
    const generated = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    if (generated.ok) {
      const [inv] = await db
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId));
      expect(inv.subtotalMinor).toBe(150000 + 25317);
    }

    // Cleanup: release entries for the later tests in this file.
    const lines = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    for (const line of lines) {
      await deleteInvoiceLine(db, business.id, line.id);
    }
  });

  it("edits a draft line in place and recomputes totals", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;

    await addManualLine(db, business.id, {
      invoiceId,
      description: "Retainer",
      amountMajor: "1000",
    });
    const [manualLine] = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));

    // Description + amount edit flows through to the invoice totals.
    const edited = await updateInvoiceLine(db, business.id, {
      lineId: manualLine.id,
      description: "Monthly retainer",
      amountMajor: "1200",
    });
    expect(edited).toMatchObject({ ok: true });
    if (edited.ok) {
      expect(edited.invoice?.subtotalMinor).toBe(120000);
      expect(edited.invoice?.taxMinor).toBe(25200);
      expect(edited.invoice?.totalMinor).toBe(145200);
    }
    const [afterEdit] = await db
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.id, manualLine.id));
    expect(afterEdit.description).toBe("Monthly retainer");
    expect(afterEdit.totalMinor).toBe(120000);

    // More decimals than the currency allows is rejected, never rounded.
    expect(
      await updateInvoiceLine(db, business.id, {
        lineId: manualLine.id,
        description: "Monthly retainer",
        amountMajor: "1200.005",
      }),
    ).toMatchObject({ ok: false, reason: "bad_amount" });

    // A generated line carries an hours x rate breakdown (253.17 in the S7
    // example)...
    await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    const [timeLine] = await db
      .select()
      .from(schema.invoiceLine)
      .where(
        and(
          eq(schema.invoiceLine.invoiceId, invoiceId),
          isNotNull(schema.invoiceLine.quantity),
        ),
      );
    expect(timeLine.quantity).not.toBeNull();

    // ...a description-only edit (same amount) keeps the breakdown...
    await updateInvoiceLine(db, business.id, {
      lineId: timeLine.id,
      description: "Design work",
      amountMajor: "253.17",
    });
    const [renamed] = await db
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.id, timeLine.id));
    expect(renamed.description).toBe("Design work");
    expect(renamed.quantity).toBe(timeLine.quantity);
    expect(renamed.unitPriceMinor).toBe(timeLine.unitPriceMinor);

    // ...but changing the amount drops the now-inconsistent breakdown.
    await updateInvoiceLine(db, business.id, {
      lineId: timeLine.id,
      description: "Design work",
      amountMajor: "250",
    });
    const [overridden] = await db
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.id, timeLine.id));
    expect(overridden.quantity).toBeNull();
    expect(overridden.unitPriceMinor).toBeNull();
    expect(overridden.totalMinor).toBe(25000);

    // Cleanup: release entries for the later tests in this file.
    const lines = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    for (const line of lines) {
      await deleteInvoiceLine(db, business.id, line.id);
    }
  });

  it("sets and clears free-text notes on a draft, but not once issued", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "zero_rated",
    });
    const invoiceId = (draft as { id: string }).id;

    const saved = await setInvoiceNotes(
      db,
      business.id,
      invoiceId,
      "  Payment due within 14 days.\nThank you!  ",
    );
    // Trimmed at the edges, inner newline preserved for multi-line notes.
    expect(saved?.notes).toBe("Payment due within 14 days.\nThank you!");

    // An all-whitespace value clears the notes.
    const cleared = await setInvoiceNotes(db, business.id, invoiceId, "   ");
    expect(cleared?.notes).toBeNull();

    // Another business cannot touch it.
    expect(await setInvoiceNotes(db, "00000000-0000-0000-0000-000000000000", invoiceId, "x")).toBeNull();

    // Once issued, notes are frozen like the rest of the document.
    await setInvoiceNotes(db, business.id, invoiceId, "Final note");
    const issued = await issueInvoice(
      db,
      business.id,
      invoiceId,
      new Date("2026-06-15T12:00:00Z"),
    );
    expect(issued.ok).toBe(true);
    expect(await setInvoiceNotes(db, business.id, invoiceId, "too late")).toBeNull();
  });

  it("deleting a draft releases its billed time back to unbilled", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;

    const gen = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "single",
    });
    expect(gen.ok).toBe(true);

    // The billable entries are now linked to this invoice's lines.
    const linkedBefore = await db
      .select({ id: schema.timeEntry.id })
      .from(schema.timeEntry)
      .innerJoin(
        schema.invoiceLine,
        eq(schema.timeEntry.invoiceLineId, schema.invoiceLine.id),
      )
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    expect(linkedBefore.length).toBeGreaterThan(0);

    // Deleting the draft removes it and its lines...
    expect(await deleteDraftInvoice(db, business.id, invoiceId)).not.toBeNull();
    const [gone] = await db
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.id, invoiceId));
    expect(gone).toBeUndefined();
    const lines = await db
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    expect(lines).toHaveLength(0);

    // ...and the entries are unbilled again (the cascade set the link null).
    const releasable = await db
      .select({ id: schema.timeEntry.id })
      .from(schema.timeEntry)
      .where(
        and(
          eq(schema.timeEntry.businessId, business.id),
          eq(schema.timeEntry.billable, true),
          isNull(schema.timeEntry.invoiceLineId),
        ),
      );
    expect(releasable.length).toBeGreaterThan(0);
  });

  it("voiding an issued invoice releases its billed time back to unbilled", async () => {
    // A dedicated task + billable entry so this test owns its billed time.
    const voidTask = (await createTask(db, business.id, project.id, {
      title: "Void-me task",
      status: "in_progress",
    })) as { id: string };
    const entry = await logManualEntry(db, business.id, user, {
      taskId: voidTask.id,
      startedAt: new Date("2026-06-20T09:00:00Z"),
      durationSeconds: 3600,
      billable: true,
    });
    const entryId = (entry as { id: string }).id;

    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;

    const gen = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "single",
    });
    expect(gen.ok).toBe(true);

    // Issue it so it is a real sent document - drafts are deleted, not voided.
    const issued = await issueInvoice(db, business.id, invoiceId);
    expect(issued.ok).toBe(true);

    // The entry is now billed on this invoice's line.
    const [billed] = await db
      .select({ invoiceLineId: schema.timeEntry.invoiceLineId })
      .from(schema.timeEntry)
      .where(eq(schema.timeEntry.id, entryId));
    expect(billed.invoiceLineId).not.toBeNull();

    // Voiding releases the entry back to the unbilled pool...
    const voided = await voidInvoice(
      db,
      business.id,
      user,
      invoiceId,
      "duplicate",
    );
    expect(voided?.status).toBe("void");
    const [released] = await db
      .select({ invoiceLineId: schema.timeEntry.invoiceLineId })
      .from(schema.timeEntry)
      .where(eq(schema.timeEntry.id, entryId));
    expect(released.invoiceLineId).toBeNull();

    // ...while the voided invoice keeps its lines for the record.
    const lines = await db
      .select()
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("lists the entries' timesheet notes in logged order when asked, and Replace rebuilds them", async () => {
    // Own client so the shared entries above stay out of it.
    const notesClient = await createClient(db, business.id, user, {
      name: "Notes Ltd",
      contacts: [],
      defaultRateMinor: 2375,
      defaultRateCurrency: "EUR",
    });
    const notesProject = (await createProject(db, business.id, user, {
      name: "Retainer",
      clientId: notesClient.id,
      status: "active",
    })) as { id: string };
    const notesTask = (await createTask(db, business.id, notesProject.id, {
      title: "xWave - Invoice 14",
      status: "in_progress",
    })) as { id: string };
    // Logged out of order on purpose: the line follows startedAt.
    for (const [day, note] of [
      ["2026-10-21", "Release notes"],
      ["2026-10-20", "Fixed login redirect\nCode review"],
      ["2026-10-22", undefined],
    ] as const) {
      await logManualEntry(db, business.id, user, {
        taskId: notesTask.id,
        startedAt: new Date(`${day}T09:00:00Z`),
        durationSeconds: 3600,
        billable: true,
        note,
      });
    }
    const draft = await createDraftInvoice(db, business.id, {
      clientId: notesClient.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;
    const lineDescriptions = async () =>
      (
        await db
          .select({ description: schema.invoiceLine.description })
          .from(schema.invoiceLine)
          .where(eq(schema.invoiceLine.invoiceId, invoiceId))
      ).map((l) => l.description);

    await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
      includeTaskList: true,
    });
    expect(await lineDescriptions()).toEqual([
      "Shay - 23.75 EUR/h (xWave - Invoice 14)",
    ]);

    // Tom's case: the notes were left off the first time, so Replace
    // with the option on has to rebuild the line with them.
    const replaced = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
      includeTaskList: true,
      includeNotes: true,
      replace: true,
    });
    expect(replaced).toMatchObject({ ok: true, lineCount: 1 });
    expect(await lineDescriptions()).toEqual([
      "Shay - 23.75 EUR/h (xWave - Invoice 14)\n- Fixed login redirect\n- Code review\n- Release notes",
    ]);
  });

  it("refuses to add generated lines to an issued invoice", async () => {
    const draft = await createDraftInvoice(db, business.id, {
      clientId: client.id,
      currency: "EUR",
      taxTreatment: "standard",
      standardRatePercent: "21",
    });
    const invoiceId = (draft as { id: string }).id;
    await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    const issued = await issueInvoice(db, business.id, invoiceId);
    expect(issued.ok && issued.invoice.number).toBeTruthy();

    const blocked = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId,
      grouping: "person_rate",
    });
    expect(blocked).toMatchObject({ ok: false, reason: "no_draft" });

    // And issued lines cannot be deleted...
    const [line] = await db
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId));
    expect(await deleteInvoiceLine(db, business.id, line.id)).toBeNull();

    // ...nor edited.
    expect(
      await updateInvoiceLine(db, business.id, {
        lineId: line.id,
        description: "Nope",
        amountMajor: "10",
      }),
    ).toMatchObject({ ok: false, reason: "no_draft" });
  });
});
