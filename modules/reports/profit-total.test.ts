import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createClient } from "@/modules/clients/service";
import { createProject } from "@/modules/projects/service";
import { createTask } from "@/modules/projects/tasks-service";
import { createTestDatabase } from "@/db/testing";
import { FxRateCache } from "@/modules/billing/fx-cache";

import {
  foldConvertedTotal,
  profitTotalSummary,
  type DatedRow,
  type RateFetcher,
} from "./profit-total";

describe("foldConvertedTotal (pure core)", () => {
  it("passes through rows already in the target currency untouched", () => {
    const result = foldConvertedTotal(
      {
        income: [{ currency: "EUR", amountMinor: 100_000, date: new Date("2026-05-01") }],
        expenses: [{ currency: "EUR", amountMinor: 10_000, date: new Date("2026-05-01") }],
        labour: [],
      },
      "EUR",
      new Map(),
    );
    expect(result).toMatchObject({
      currency: "EUR",
      incomeMinor: 100_000,
      expenseMinor: 10_000,
      labourMinor: 0,
      profitMinor: 90_000,
      unconverted: [],
    });
  });

  it("converts foreign rows using the rate for their own (currency, day)", () => {
    const income: DatedRow[] = [
      { currency: "GBP", amountMinor: 46_500, date: new Date("2026-06-08T15:00:00Z") },
    ];
    const rates = new Map([["GBP|2026-06-08", "1.1734"]]);
    const result = foldConvertedTotal({ income, expenses: [], labour: [] }, "EUR", rates);
    // 465.00 GBP at 1.1734 -> 545.63 EUR (54563 minor), per money.ts's spec example.
    expect(result.incomeMinor).toBe(54_563);
    expect(result.unconverted).toEqual([]);
  });

  it("excludes rows with no rate for their pair and lists them as unconverted", () => {
    const income: DatedRow[] = [
      { currency: "EUR", amountMinor: 100_000, date: new Date("2026-05-01") },
      { currency: "USD", amountMinor: 20_000, date: new Date("2026-05-02") },
    ];
    const result = foldConvertedTotal({ income, expenses: [], labour: [] }, "EUR", new Map());
    expect(result.incomeMinor).toBe(100_000);
    expect(result.unconverted).toEqual([
      { currency: "USD", amountMinor: 20_000, date: "2026-05-02" },
    ]);
  });

  it("allows negative profit", () => {
    const result = foldConvertedTotal(
      {
        income: [{ currency: "EUR", amountMinor: 10_000, date: new Date("2026-05-01") }],
        expenses: [{ currency: "EUR", amountMinor: 8_000, date: new Date("2026-05-01") }],
        labour: [{ currency: "EUR", amountMinor: 9_000, date: new Date("2026-05-01") }],
      },
      "EUR",
      new Map(),
    );
    expect(result.profitMinor).toBe(-7_000);
  });
});

let pglite: PGlite;
let db: Db;
let businessA: { id: string };
const userA = "profit-total-user-a";

async function seedBilledWork(opts: {
  businessId: string;
  clientId: string;
  taskId: string;
  status: "sent" | "paid";
  currency: string;
  issueDate: Date;
  invoiceTotalMinor: number;
  internalCostHourly: number;
  internalCostCurrency: string;
  durationSeconds: number;
}) {
  const [invoice] = await db
    .insert(schema.invoice)
    .values({
      businessId: opts.businessId,
      clientId: opts.clientId,
      status: opts.status,
      currency: opts.currency,
      issueDate: opts.issueDate,
      taxTreatment: "zero_rated",
      totalMinor: opts.invoiceTotalMinor,
      subtotalMinor: opts.invoiceTotalMinor,
    })
    .returning();
  const [line] = await db
    .insert(schema.invoiceLine)
    .values({
      businessId: opts.businessId,
      invoiceId: invoice.id,
      position: 1,
      description: "Work",
      totalMinor: opts.invoiceTotalMinor,
    })
    .returning();
  await db.insert(schema.timeEntry).values({
    businessId: opts.businessId,
    taskId: opts.taskId,
    userId: userA,
    startedAt: opts.issueDate,
    endedAt: opts.issueDate,
    durationSeconds: opts.durationSeconds,
    billable: true,
    rateMinor: 4000,
    rateCurrency: opts.currency,
    internalCostMinor: opts.internalCostHourly,
    internalCostCurrency: opts.internalCostCurrency,
    invoiceLineId: line.id,
  });
}

// A fixed lookup keyed the same way rateKey() builds its map keys, so the
// test never hits the network.
function stubRates(table: Record<string, string>): RateFetcher {
  return async ({ date, from, to }) => {
    const key = `${from}|${date.toISOString().slice(0, 10)}|${to}`;
    const rate = table[key];
    return rate ? { rate } : null;
  };
}

describe("profitTotalSummary (db)", () => {
  let clientA: { id: string };
  let taskA: { id: string };

  beforeAll(async () => {
    ({ pglite, db } = await createTestDatabase());

    [businessA] = await db
      .insert(schema.business)
      .values({ name: "Total Co", currency: "EUR" })
      .returning();
    await db
      .insert(schema.user)
      .values({ id: userA, name: "Tia", email: "tia@profit-total.test" });

    clientA = await createClient(db, businessA.id, userA, {
      name: "Total client",
      contacts: [],
    });
    const project = (await createProject(db, businessA.id, userA, {
      name: "Total project",
      clientId: clientA.id,
      status: "active",
    })) as { id: string };
    taskA = (await createTask(db, businessA.id, project.id, {
      title: "Total task",
      status: "todo",
    })) as { id: string };

    // EUR invoice: no conversion needed. GBP 8h at GBP 27.50/h internal
    // cost = GBP 220 labour, converted at the invoice's own issue date.
    await seedBilledWork({
      businessId: businessA.id,
      clientId: clientA.id,
      taskId: taskA.id,
      status: "paid",
      currency: "EUR",
      issueDate: new Date("2026-05-01T00:00:00Z"),
      invoiceTotalMinor: 80_000,
      internalCostHourly: 2750,
      internalCostCurrency: "GBP",
      durationSeconds: 8 * 3600,
    });
    // GBP invoice on a different day - needs its own rate.
    await seedBilledWork({
      businessId: businessA.id,
      clientId: clientA.id,
      taskId: taskA.id,
      status: "sent",
      currency: "GBP",
      issueDate: new Date("2026-06-08T00:00:00Z"),
      invoiceTotalMinor: 46_500,
      internalCostHourly: 0,
      internalCostCurrency: "GBP",
      durationSeconds: 0,
    });

    await db.insert(schema.expense).values([
      {
        businessId: businessA.id,
        description: "USD tool subscription",
        amountMinor: 10_000,
        currency: "USD",
        status: "paid",
        incurredAt: new Date("2026-05-15T00:00:00Z"),
      },
    ]);
  });

  afterAll(async () => {
    await pglite.close();
  });

  it("converts every currency to the business's base currency using each row's own date", async () => {
    const fetchRate = stubRates({
      "GBP|2026-05-01|EUR": "1.1700",
      "GBP|2026-06-08|EUR": "1.1734",
      "USD|2026-05-15|EUR": "0.9200",
    });
    const result = await profitTotalSummary(db, businessA.id, {}, { fetchRate });

    expect(result.currency).toBe("EUR");
    expect(result.unconverted).toEqual([]);
    // Income: EUR 800 (as-is) + GBP 465 at 1.1734 = EUR 545.63 -> 134563.
    expect(result.incomeMinor).toBe(80_000 + 54_563);
    // Expenses: USD 100 at 0.92 -> EUR 92.00 -> 9200.
    expect(result.expenseMinor).toBe(9_200);
    // Labour: GBP 220 at 1.17 -> EUR 257.40 -> 25740.
    expect(result.labourMinor).toBe(25_740);
    expect(result.profitMinor).toBe(
      result.incomeMinor - result.expenseMinor - result.labourMinor,
    );
  });

  it("excludes and lists amounts whose rate is unavailable, without failing the whole report", async () => {
    const fetchRate = stubRates({
      "GBP|2026-05-01|EUR": "1.1700",
      // GBP|2026-06-08 and USD|2026-05-15 deliberately missing.
    });
    const result = await profitTotalSummary(db, businessA.id, {}, { fetchRate });

    expect(result.incomeMinor).toBe(80_000);
    expect(result.expenseMinor).toBe(0);
    expect(result.unconverted).toEqual(
      expect.arrayContaining([
        { currency: "GBP", amountMinor: 46_500, date: "2026-06-08" },
        { currency: "USD", amountMinor: 10_000, date: "2026-05-15" },
      ]),
    );
  });

  it("treats a thrown rate lookup the same as an unpriced pair", async () => {
    const fetchRate: RateFetcher = async ({ from }) => {
      if (from === "USD") throw new Error("frankfurter is down");
      return { rate: "1.17" };
    };
    const result = await profitTotalSummary(db, businessA.id, {}, { fetchRate });
    expect(result.unconverted).toEqual([
      { currency: "USD", amountMinor: 10_000, date: "2026-05-15" },
    ]);
  });

  it("fetches each settled rate once: a second report, and one after a restart, make no requests (#5689)", async () => {
    const stub = stubRates({
      "GBP|2026-05-01|EUR": "1.1700",
      "GBP|2026-06-08|EUR": "1.1734",
      "USD|2026-05-15|EUR": "0.9200",
    });
    let requests = 0;
    const source = async (request: { date: Date; from: string; to: string }) => {
      requests++;
      const result = await stub(request);
      return result
        ? { ...result, effectiveDate: request.date.toISOString().slice(0, 10), source: "ecb" as const }
        : null;
    };
    const now = () => new Date("2026-11-24T12:00:00Z");
    const uncached = await profitTotalSummary(db, businessA.id, {}, { fetchRate: stub });

    const cache = new FxRateCache({ source, now });
    const first = await profitTotalSummary(db, businessA.id, {}, { rateCache: cache });
    expect(requests).toBe(3);
    const second = await profitTotalSummary(db, businessA.id, {}, { rateCache: cache });
    expect(requests).toBe(3);
    // A fresh process (new in-memory map) finds them in fx_rate.
    const afterRestart = await profitTotalSummary(db, businessA.id, {}, {
      rateCache: new FxRateCache({ source, now }),
    });
    expect(requests).toBe(3);

    expect(first).toEqual(uncached);
    expect(second).toEqual(uncached);
    expect(afterRestart).toEqual(uncached);
    await db.delete(schema.fxRate);
  });

  it("honours the date range on issue/incurred dates", async () => {
    const fetchRate = stubRates({ "GBP|2026-05-01|EUR": "1.1700" });
    const result = await profitTotalSummary(
      db,
      businessA.id,
      { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") },
      { fetchRate },
    );
    // Only the EUR 800 (May) invoice and USD 100 (May) expense are in
    // range; the June GBP invoice is excluded entirely.
    expect(result.incomeMinor).toBe(80_000);
    expect(result.unconverted).toEqual([
      { currency: "USD", amountMinor: 10_000, date: "2026-05-15" },
    ]);
  });
});
