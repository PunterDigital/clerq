// Converted profit total: profit.ts keeps every figure in its own
// currency by design (see its header comment) - this module answers the
// different question "what's the total, in one currency". It reuses the
// accrual scope (an invoice counts once issued, an expense once
// incurred, labour once its invoice is issued) because that scope *is*
// the invoice basis: each figure is converted at the rate in effect on
// the date the invoice was issued or the expense was incurred, never on
// today's date or on whatever day it was eventually paid. Fixing the
// rate to the transaction's own date is the most accurate conversion
// available, and mirrors how per-line FX is fixed at generation time
// (modules/billing/generate.ts).
//
// A pure core folds pre-dated, currency-tagged rows into one total given
// a lookup of already-fetched rates; a thin db wrapper assembles those
// rows and fetches one rate per distinct (currency, day) pair actually
// needed. A pair the FX source can't price (see fx.ts) is never silently
// dropped: it is excluded from the total and listed in `unconverted` so
// the caller can say so.

import { and, eq, gte, isNotNull, lt, notInArray } from "drizzle-orm";

import type { Db } from "@/db";
import { schema } from "@/db";

import { fxRateCache, rateCacheKey, type FxRateCache } from "@/modules/billing/fx-cache";
import { convertMinor, lineTotalMinorFromSeconds } from "@/modules/billing/money";

export type DatedRow = { currency: string; amountMinor: number; date: Date };

export type UnconvertedAmount = {
  currency: string;
  amountMinor: number;
  date: string;
};

export type ConvertedTotal = {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  labourMinor: number;
  profitMinor: number;
  // Amounts whose currency/day pair could not be priced - excluded from
  // the totals above, kept here so nothing vanishes unexplained.
  unconverted: UnconvertedAmount[];
};

function rateKey(currency: string, date: Date): string {
  return `${currency}|${date.toISOString().slice(0, 10)}`;
}

// Pure core: folds dated, currency-tagged rows into one total in
// `targetCurrency`, given a lookup of rate strings already fetched for
// every (currency, day) pair the rows need. A missing entry means that
// pair could not be priced - the row moves to `unconverted` rather than
// being guessed at or dropped.
export function foldConvertedTotal(
  input: { income: DatedRow[]; expenses: DatedRow[]; labour: DatedRow[] },
  targetCurrency: string,
  rates: Map<string, string>,
): ConvertedTotal {
  const unconverted: UnconvertedAmount[] = [];

  const convert = (row: DatedRow): number | null => {
    if (row.currency === targetCurrency) return row.amountMinor;
    const rate = rates.get(rateKey(row.currency, row.date));
    if (!rate) {
      unconverted.push({
        currency: row.currency,
        amountMinor: row.amountMinor,
        date: row.date.toISOString().slice(0, 10),
      });
      return null;
    }
    // Credit notes come in negative; convertMinor takes amounts >= 0.
    const converted = convertMinor(
      Math.abs(row.amountMinor),
      rate,
      row.currency,
      targetCurrency,
    );
    return row.amountMinor < 0 ? -converted : converted;
  };

  const sum = (rows: DatedRow[]) =>
    rows.reduce((total, row) => {
      const converted = convert(row);
      return converted === null ? total : total + converted;
    }, 0);

  const incomeMinor = sum(input.income);
  const expenseMinor = sum(input.expenses);
  const labourMinor = sum(input.labour);

  return {
    currency: targetCurrency,
    incomeMinor,
    expenseMinor,
    labourMinor,
    profitMinor: incomeMinor - expenseMinor - labourMinor,
    unconverted,
  };
}

export type ProfitTotalRange = { from?: Date; to?: Date };

export type RateFetcher = (opts: {
  date: Date;
  from: string;
  to: string;
}) => Promise<{ rate: string } | null>;

// Assembles the converted total for a business on the invoice basis.
// Fetches one FX rate per distinct (currency, day) pair the scope needs
// (not one per row - a hundred invoices sharing a day and currency cost
// one request) and converts every row into the business's base
// currency. A rate lookup that fails or comes back unpriced is treated
// the same as "no rate available": the row surfaces in `unconverted`
// instead of failing the whole report.
//
// Rates come from `rateCache` (default: the process-wide FxRateCache, so a
// settled day's rate is fetched once, #5689). A test that passes only
// `fetchRate` gets that function called for every pair, uncached.
export async function profitTotalSummary(
  db: Db,
  businessId: string,
  range: ProfitTotalRange = {},
  opts: { fetchRate?: RateFetcher; rateCache?: FxRateCache } = {},
): Promise<ConvertedTotal> {
  const cache = opts.rateCache ?? (opts.fetchRate ? null : fxRateCache);

  const [business] = await db
    .select({ currency: schema.business.currency })
    .from(schema.business)
    .where(eq(schema.business.id, businessId));
  if (!business) {
    throw new Error(`profitTotalSummary: business ${businessId} not found`);
  }
  const targetCurrency = business.currency;

  const invoiceScope = [
    eq(schema.invoice.businessId, businessId),
    notInArray(schema.invoice.status, ["draft", "void"]),
    isNotNull(schema.invoice.issueDate),
  ];
  if (range.from) invoiceScope.push(gte(schema.invoice.issueDate, range.from));
  if (range.to) invoiceScope.push(lt(schema.invoice.issueDate, range.to));

  const invoiceRows = await db
    .select({
      currency: schema.invoice.currency,
      totalMinor: schema.invoice.totalMinor,
      issueDate: schema.invoice.issueDate,
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
    })
    .from(schema.creditNote)
    .where(and(...creditScope));

  const expenseScope = [eq(schema.expense.businessId, businessId)];
  if (range.from) expenseScope.push(gte(schema.expense.incurredAt, range.from));
  if (range.to) expenseScope.push(lt(schema.expense.incurredAt, range.to));

  const expenseRows = await db
    .select({
      currency: schema.expense.currency,
      amountMinor: schema.expense.amountMinor,
      incurredAt: schema.expense.incurredAt,
    })
    .from(schema.expense)
    .where(and(...expenseScope));

  // Same join as profit.ts's labour scope: cost currency is the
  // worker's, date is the invoice's issue date.
  const labourScope = [
    eq(schema.timeEntry.businessId, businessId),
    isNotNull(schema.timeEntry.internalCostMinor),
    notInArray(schema.invoice.status, ["draft", "void"]),
    isNotNull(schema.invoice.issueDate),
  ];
  if (range.from) labourScope.push(gte(schema.invoice.issueDate, range.from));
  if (range.to) labourScope.push(lt(schema.invoice.issueDate, range.to));

  const labourRows = await db
    .select({
      durationSeconds: schema.timeEntry.durationSeconds,
      internalCostMinor: schema.timeEntry.internalCostMinor,
      internalCostCurrency: schema.timeEntry.internalCostCurrency,
      issueDate: schema.invoice.issueDate,
    })
    .from(schema.timeEntry)
    .innerJoin(
      schema.invoiceLine,
      eq(schema.timeEntry.invoiceLineId, schema.invoiceLine.id),
    )
    .innerJoin(schema.invoice, eq(schema.invoiceLine.invoiceId, schema.invoice.id))
    .where(and(...labourScope));

  const income: DatedRow[] = [
    ...invoiceRows.map((r) => ({
      currency: r.currency,
      amountMinor: r.totalMinor,
      date: r.issueDate as Date,
    })),
    ...creditRows.map((r) => ({
      currency: r.currency,
      amountMinor: -r.totalMinor,
      date: r.issueDate,
    })),
  ];
  const expenses: DatedRow[] = expenseRows.map((r) => ({
    currency: r.currency,
    amountMinor: r.amountMinor,
    date: r.incurredAt,
  }));
  const labour: DatedRow[] = labourRows
    .filter((r) => r.internalCostCurrency && r.internalCostMinor != null)
    .map((r) => ({
      currency: r.internalCostCurrency as string,
      amountMinor: lineTotalMinorFromSeconds(
        r.durationSeconds ?? 0,
        r.internalCostMinor as number,
      ),
      date: r.issueDate as Date,
    }));

  const pairs = new Map<string, { currency: string; date: Date }>();
  for (const row of [...income, ...expenses, ...labour]) {
    if (row.currency === targetCurrency) continue;
    const key = rateKey(row.currency, row.date);
    if (!pairs.has(key)) pairs.set(key, { currency: row.currency, date: row.date });
  }

  const rates = new Map<string, string>();
  if (cache) {
    const cached = await cache.getRates(
      db,
      [...pairs.values()].map(({ currency, date }) => ({ date, from: currency, to: targetCurrency })),
    );
    for (const [key, { currency, date }] of pairs) {
      const result = cached.get(
        rateCacheKey(date.toISOString().slice(0, 10), currency, targetCurrency),
      );
      // A pair left out (its lookup failed) or null (no rate) stays unpriced.
      if (result) rates.set(key, result.rate);
    }
  } else {
    const fetchRate = opts.fetchRate as RateFetcher;
    await Promise.all(
      [...pairs.entries()].map(async ([key, { currency, date }]) => {
        try {
          const result = await fetchRate({ date, from: currency, to: targetCurrency });
          if (result) rates.set(key, result.rate);
        } catch {
          // Same handling as a 404 from the FX source: the pair stays
          // unpriced and its rows fall through to `unconverted`.
        }
      }),
    );
  }

  return foldConvertedTotal({ income, expenses, labour }, targetCurrency, rates);
}
