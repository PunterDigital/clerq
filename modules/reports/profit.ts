// Profit reporting: income - expenses - what the business pays its team.
// A pure core folds currency-tagged contributions into per-currency buckets,
// and a thin db wrapper assembles those contributions from invoices, expenses
// and the internal cost frozen on billed time entries. Two bases are reported
// side by side:
//   cash    - only money that has actually moved (paid invoices, paid
//             expenses, and the cost of time billed on a paid invoice).
//   accrual - everything recognised (issued invoices, all recorded expenses,
//             and the cost of all billed time, paid or not).
// Money never crosses currencies here (there is no FX in this module): every
// figure stays in the currency it was denominated in, so a EUR-billed /
// USD-paid contractor surfaces as two currency rows. The final subtraction is
// plain integer arithmetic - profit can be negative, so it must not run
// through roundHalfUpDiv (which rejects negatives).

import { and, eq, gte, isNotNull, lt, notInArray } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";

import { lineTotalMinorFromSeconds } from "@/modules/billing/money";

// A single contribution to the report. `paid` marks whether it counts toward
// the cash basis (it always counts toward accrual).
export type ProfitRow = { currency: string; amountMinor: number; paid: boolean };

export type ProfitInput = {
  income: ProfitRow[];
  expenses: ProfitRow[];
  labour: ProfitRow[];
};

export type ProfitBucket = {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  labourMinor: number;
  profitMinor: number;
};

export type ProfitReport = { cash: ProfitBucket[]; accrual: ProfitBucket[] };

function emptyBucket(currency: string): ProfitBucket {
  return {
    currency,
    incomeMinor: 0,
    expenseMinor: 0,
    labourMinor: 0,
    profitMinor: 0,
  };
}

// Folds one basis (a predicate over `paid`) into per-currency buckets. Plain
// integer sums; profit is the signed remainder and may be negative.
function foldBasis(input: ProfitInput, cashOnly: boolean): ProfitBucket[] {
  const buckets = new Map<string, ProfitBucket>();
  const get = (currency: string) => {
    const existing = buckets.get(currency);
    if (existing) return existing;
    const fresh = emptyBucket(currency);
    buckets.set(currency, fresh);
    return fresh;
  };
  const include = (row: ProfitRow) => !cashOnly || row.paid;

  for (const row of input.income) {
    if (include(row)) get(row.currency).incomeMinor += row.amountMinor;
  }
  for (const row of input.expenses) {
    if (include(row)) get(row.currency).expenseMinor += row.amountMinor;
  }
  for (const row of input.labour) {
    if (include(row)) get(row.currency).labourMinor += row.amountMinor;
  }
  for (const bucket of buckets.values()) {
    bucket.profitMinor =
      bucket.incomeMinor - bucket.expenseMinor - bucket.labourMinor;
  }
  // Stable order so the UI renders deterministically.
  return [...buckets.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

export function computeProfit(input: ProfitInput): ProfitReport {
  return {
    cash: foldBasis(input, true),
    accrual: foldBasis(input, false),
  };
}

export type ProfitRange = { from?: Date; to?: Date };

// Assembles the profit report for a business. An invoice counts once it is
// issued (number assigned) - drafts are excluded from both bases. The optional
// range filters invoices and labour by issue date and expenses by the date the
// cost was incurred.
export async function profitSummary(
  db: Db,
  businessId: string,
  range: ProfitRange = {},
): Promise<ProfitReport> {
  // Issued invoices (status is never draft once issued). Voided invoices are
  // excluded: the number is kept for the record but it is not revenue.
  const invoiceScope = [
    eq(schema.invoice.businessId, businessId),
    notInArray(schema.invoice.status, ["draft", "void"]),
  ];
  if (range.from) invoiceScope.push(gte(schema.invoice.issueDate, range.from));
  if (range.to) invoiceScope.push(lt(schema.invoice.issueDate, range.to));

  const invoiceRows = await db
    .select({
      currency: schema.invoice.currency,
      totalMinor: schema.invoice.totalMinor,
      status: schema.invoice.status,
    })
    .from(schema.invoice)
    .where(and(...invoiceScope));

  // Credit notes (#5042) are negative revenue on their own issue date.
  const creditScope = [eq(schema.creditNote.businessId, businessId)];
  if (range.from) creditScope.push(gte(schema.creditNote.issueDate, range.from));
  if (range.to) creditScope.push(lt(schema.creditNote.issueDate, range.to));
  const creditRows = await db
    .select({
      currency: schema.creditNote.currency,
      totalMinor: schema.creditNote.totalMinor,
      issueDate: schema.creditNote.issueDate,
      invoiceStatus: schema.invoice.status,
    })
    .from(schema.creditNote)
    .innerJoin(schema.invoice, eq(schema.creditNote.invoiceId, schema.invoice.id))
    .where(and(...creditScope));

  const expenseScope = [eq(schema.expense.businessId, businessId)];
  if (range.from) expenseScope.push(gte(schema.expense.incurredAt, range.from));
  if (range.to) expenseScope.push(lt(schema.expense.incurredAt, range.to));

  const expenseRows = await db
    .select({
      currency: schema.expense.currency,
      amountMinor: schema.expense.amountMinor,
      status: schema.expense.status,
    })
    .from(schema.expense)
    .where(and(...expenseScope));

  // Internal cost of billed time: each entry links to an invoice line, and the
  // line to an issued invoice. The cost currency is the worker's, not the
  // invoice's. Entries with no internal cost contribute nothing.
  const labourScope = [
    eq(schema.timeEntry.businessId, businessId),
    isNotNull(schema.timeEntry.internalCostMinor),
    notInArray(schema.invoice.status, ["draft", "void"]),
  ];
  if (range.from) labourScope.push(gte(schema.invoice.issueDate, range.from));
  if (range.to) labourScope.push(lt(schema.invoice.issueDate, range.to));

  const labourRows = await db
    .select({
      durationSeconds: schema.timeEntry.durationSeconds,
      internalCostMinor: schema.timeEntry.internalCostMinor,
      internalCostCurrency: schema.timeEntry.internalCostCurrency,
      invoiceStatus: schema.invoice.status,
    })
    .from(schema.timeEntry)
    .innerJoin(
      schema.invoiceLine,
      eq(schema.timeEntry.invoiceLineId, schema.invoiceLine.id),
    )
    .innerJoin(schema.invoice, eq(schema.invoiceLine.invoiceId, schema.invoice.id))
    .where(and(...labourScope));

  const input: ProfitInput = {
    income: [
      ...invoiceRows.map((r) => ({
        currency: r.currency,
        amountMinor: r.totalMinor,
        paid: r.status === "paid",
      })),
      // A credit note on a paid invoice gives money back (cash and
      // accrual); on an unpaid one it only cancels what was never received.
      ...creditRows.map((r) => ({
        currency: r.currency,
        amountMinor: -r.totalMinor,
        paid: r.invoiceStatus === "paid",
      })),
    ],
    expenses: expenseRows.map((r) => ({
      currency: r.currency,
      amountMinor: r.amountMinor,
      paid: r.status === "paid",
    })),
    labour: labourRows
      .filter((r) => r.internalCostCurrency && r.internalCostMinor != null)
      .map((r) => ({
        currency: r.internalCostCurrency as string,
        amountMinor: lineTotalMinorFromSeconds(
          r.durationSeconds ?? 0,
          r.internalCostMinor as number,
        ),
        paid: r.invoiceStatus === "paid",
      })),
  };

  return computeProfit(input);
}
