import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { createClient, updateClient } from "@/modules/clients/service";
import { createProject } from "@/modules/projects/service";
import { createTask } from "@/modules/projects/tasks-service";
import { logManualEntry } from "@/modules/time/service";

import {
  addManualLine,
  generateLinesFromUnbilledTime,
  updateInvoiceLine,
} from "./generate";
import {
  createDraftInvoice,
  duplicateInvoice,
  updateInvoiceDetails,
} from "./invoices";

// E-invoicing fields (#5039): UN/ECE unit codes on lines, the buyer
// reference (client default -> invoice) and the VATEX code.

let pglite: PGlite;
let db: Db;
let business: { id: string };
let client: { id: string; buyerReference: string | null };
const user = "user-a";

async function lines(invoiceId: string) {
  return db
    .select()
    .from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, invoiceId))
    .orderBy(schema.invoiceLine.position);
}

async function draft() {
  const created = await createDraftInvoice(db, business.id, {
    clientId: client.id,
    currency: "EUR",
    taxTreatment: "reverse_charge",
  });
  expect(created).not.toBeNull();
  return created as NonNullable<typeof created>;
}

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  [business] = await db
    .insert(schema.business)
    .values({ name: "Alpha Studio", currency: "EUR" })
    .returning();
  await db
    .insert(schema.user)
    .values([{ id: user, name: "Shay", email: "shay@alpha.test" }]);
  client = await createClient(db, business.id, user, {
    name: "Stadt Musterhausen",
    contacts: [],
    defaultRateMinor: 6000,
    defaultRateCurrency: "EUR",
    buyerReference: "  04011000-1234512345-06  ",
  });
  const project = (await createProject(db, business.id, user, {
    name: "Portal",
    clientId: client.id,
    status: "active",
  })) as { id: string };
  const task = (await createTask(db, business.id, project.id, {
    title: "Build",
    status: "in_progress",
  })) as { id: string };
  await logManualEntry(db, business.id, user, {
    taskId: task.id,
    startedAt: new Date("2026-06-08T09:00:00Z"),
    durationSeconds: 7200,
    billable: true,
  });
});

afterAll(async () => {
  await pglite.close();
});

describe("client buyer reference", () => {
  it("is stored trimmed, kept when left out and cleared by an empty string", async () => {
    expect(client.buyerReference).toBe("04011000-1234512345-06");

    const kept = await updateClient(db, business.id, user, client.id, {
      name: "Stadt Musterhausen",
      contacts: [],
    });
    expect(kept?.buyerReference).toBe("04011000-1234512345-06");

    const other = await createClient(db, business.id, user, {
      name: "Blank Ltd",
      contacts: [],
      buyerReference: "",
    });
    expect(other.buyerReference).toBeNull();
    const cleared = await updateClient(db, business.id, user, other.id, {
      name: "Blank Ltd",
      contacts: [],
      buyerReference: null,
    });
    expect(cleared?.buyerReference).toBeNull();
  });
});

describe("invoice buyer reference and VATEX code", () => {
  it("copies the client's default onto a new draft, and the draft can override it", async () => {
    const inv = await draft();
    expect(inv.buyerReference).toBe("04011000-1234512345-06");
    expect(inv.vatexCode).toBeNull();

    const updated = await updateInvoiceDetails(db, business.id, inv.id, {
      issueDate: null,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      buyerReference: "PO-7781",
      vatexCode: "VATEX-EU-AE",
    });
    expect(updated?.buyerReference).toBe("PO-7781");
    expect(updated?.vatexCode).toBe("VATEX-EU-AE");

    // Dates-only callers (the REST API, older MCP clients) keep both.
    const datesOnly = await updateInvoiceDetails(db, business.id, inv.id, {
      issueDate: null,
      dueDate: new Date("2026-07-01T00:00:00Z"),
      periodStart: null,
      periodEnd: null,
    });
    expect(datesOnly?.buyerReference).toBe("PO-7781");
    expect(datesOnly?.vatexCode).toBe("VATEX-EU-AE");

    const cleared = await updateInvoiceDetails(db, business.id, inv.id, {
      issueDate: null,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      buyerReference: null,
      vatexCode: null,
    });
    expect(cleared?.buyerReference).toBeNull();
    expect(cleared?.vatexCode).toBeNull();

    // The client's default is untouched by the override.
    const [row] = await db
      .select({ buyerReference: schema.client.buyerReference })
      .from(schema.client)
      .where(eq(schema.client.id, client.id));
    expect(row.buyerReference).toBe("04011000-1234512345-06");
  });
});

describe("line unit codes", () => {
  it("marks generated time lines HUR and manual lines C62", async () => {
    const inv = await draft();
    const generated = await generateLinesFromUnbilledTime(db, business.id, {
      invoiceId: inv.id,
      grouping: "single",
    });
    expect(generated).toMatchObject({ ok: true, lineCount: 1 });
    await addManualLine(db, business.id, {
      invoiceId: inv.id,
      description: "Setup fee",
      amountMajor: "250",
    });
    await addManualLine(db, business.id, {
      invoiceId: inv.id,
      description: "Support, two days",
      amountMajor: "900",
      unitCode: "DAY",
    });

    const [time, fixed, days] = await lines(inv.id);
    expect(time.quantity).not.toBeNull();
    expect(time.unitCode).toBe("HUR");
    expect(fixed.unitCode).toBe("C62");
    expect(days.unitCode).toBe("DAY");
  });

  it("keeps the unit on a description edit, resets it to C62 when the amount changes, and takes an explicit pick", async () => {
    const inv = await draft();
    await addManualLine(db, business.id, {
      invoiceId: inv.id,
      description: "Retainer",
      amountMajor: "1000",
      unitCode: "MON",
    });
    const [line] = await lines(inv.id);

    await updateInvoiceLine(db, business.id, {
      lineId: line.id,
      description: "Retainer, June",
      amountMajor: "1000",
    });
    expect((await lines(inv.id))[0].unitCode).toBe("MON");

    await updateInvoiceLine(db, business.id, {
      lineId: line.id,
      description: "Retainer, June",
      amountMajor: "1200",
    });
    expect((await lines(inv.id))[0].unitCode).toBe("C62");

    await updateInvoiceLine(db, business.id, {
      lineId: line.id,
      description: "Retainer, June",
      amountMajor: "1300",
      unitCode: "WEE",
    });
    expect((await lines(inv.id))[0].unitCode).toBe("WEE");
  });

  it("carries unit codes, buyer reference and VATEX code into a duplicate", async () => {
    const inv = await draft();
    await addManualLine(db, business.id, {
      invoiceId: inv.id,
      description: "Training",
      amountMajor: "500",
      unitCode: "DAY",
    });
    await updateInvoiceDetails(db, business.id, inv.id, {
      issueDate: null,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      buyerReference: "PO-1",
      vatexCode: "VATEX-EU-AE",
    });
    const copy = await duplicateInvoice(db, business.id, inv.id);
    expect(copy?.buyerReference).toBe("PO-1");
    expect(copy?.vatexCode).toBe("VATEX-EU-AE");
    expect((await lines(copy!.id))[0].unitCode).toBe("DAY");
  });

  it("backfills existing lines in the migration: hours HUR, the rest C62", () => {
    // The migration's UPDATE, checked as text: PGlite runs it on an empty
    // database, so there are no older rows to see it change.
    const sql = readMigration();
    expect(sql).toContain(
      `UPDATE "invoice_line" SET "unit_code" = 'HUR' WHERE "quantity" IS NOT NULL;`,
    );
    expect(sql).toContain(`"unit_code" text DEFAULT 'C62' NOT NULL`);
  });
});

function readMigration(): string {
  return readFileSync(
    new URL("../../db/migrations/0029_einvoicing_fields.sql", import.meta.url),
    "utf8",
  );
}
