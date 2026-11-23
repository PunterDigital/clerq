// Cached ECB rates (#5689). The Reports page converts every foreign-currency
// figure at the rate of its own day, so each visit asked Frankfurter for one
// rate per distinct (currency, day) pair and waited on the slowest answer.
// A settled day's reference rate never changes, so:
//
// - a rate for a day before today (UTC) is kept for good: in the fx_rate
//   table (survives deploys and is shared by every process) with an
//   in-process map in front, so a warm page makes no request and no query;
// - today's and future days' rates can still move (Frankfurter answers with
//   the previous business day until the ECB publishes, ~16:00 CET), so they
//   are only remembered in memory for an hour;
// - "no rate for this pair" (a 404) is remembered in memory for ten
//   minutes, never stored;
// - a failed lookup (network, 5xx) is not cached at all: the next visit asks
//   again.

import { and, inArray } from "drizzle-orm";

import { schema, type Db } from "@/db";

import { fetchEcbRate, type EcbRate } from "./fx";

export type RateRequest = { date: Date; from: string; to: string };

export type RateSource = (request: RateRequest) => Promise<EcbRate | null>;

const TODAY_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;
// Plenty for years of daily pairs; past it the oldest entries go first.
const MEMORY_LIMIT = 20_000;

type Remembered = { value: EcbRate | null; expiresAt: number };

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export function rateCacheKey(day: string, from: string, to: string): string {
  return `${day}|${from.toUpperCase()}|${to.toUpperCase()}`;
}

export class FxRateCache {
  private readonly memory = new Map<string, Remembered>();
  private readonly source: RateSource;
  private readonly now: () => Date;

  constructor(opts: { source?: RateSource; now?: () => Date } = {}) {
    this.source = opts.source ?? ((request) => fetchEcbRate(request));
    this.now = opts.now ?? (() => new Date());
  }

  // Rates for every request, keyed by rateCacheKey(day, from, to). A pair
  // with no rate maps to null; a pair whose lookup failed is left out (the
  // caller treats both as unpriced). Memory first, then one query for the
  // settled days, then the source for whatever is still missing, in
  // parallel.
  async getRates(db: Db, requests: RateRequest[]): Promise<Map<string, EcbRate | null>> {
    const nowMs = this.now().getTime();
    const today = isoDay(this.now());
    const result = new Map<string, EcbRate | null>();
    const wanted = new Map<string, RateRequest & { day: string }>();
    for (const request of requests) {
      const day = isoDay(request.date);
      const key = rateCacheKey(day, request.from, request.to);
      if (result.has(key) || wanted.has(key)) continue;
      const hit = this.memory.get(key);
      if (hit && hit.expiresAt > nowMs) {
        result.set(key, hit.value);
      } else {
        wanted.set(key, {
          ...request,
          from: request.from.toUpperCase(),
          to: request.to.toUpperCase(),
          day,
        });
      }
    }
    if (wanted.size === 0) return result;

    const settled = [...wanted.values()].filter((request) => request.day < today);
    if (settled.length > 0) {
      const rows = await db
        .select()
        .from(schema.fxRate)
        .where(
          and(
            inArray(schema.fxRate.rateDate, [...new Set(settled.map((r) => r.day))]),
            inArray(schema.fxRate.base, [...new Set(settled.map((r) => r.from))]),
            inArray(schema.fxRate.quote, [...new Set(settled.map((r) => r.to))]),
          ),
        );
      for (const row of rows) {
        const key = rateCacheKey(row.rateDate, row.base, row.quote);
        if (!wanted.has(key)) continue;
        const value: EcbRate = { rate: row.rate, effectiveDate: row.effectiveDate, source: "ecb" };
        this.remember(key, value, Infinity);
        result.set(key, value);
        wanted.delete(key);
      }
    }

    const fetched: (typeof schema.fxRate.$inferInsert)[] = [];
    await Promise.all(
      [...wanted.entries()].map(async ([key, request]) => {
        let value: EcbRate | null;
        try {
          value = await this.source({ date: request.date, from: request.from, to: request.to });
        } catch {
          return; // not cached: the next call asks again
        }
        result.set(key, value);
        if (value === null) {
          this.remember(key, null, nowMs + MISSING_TTL_MS);
        } else if (request.day < today) {
          this.remember(key, value, Infinity);
          fetched.push({
            rateDate: request.day,
            base: request.from,
            quote: request.to,
            rate: value.rate,
            effectiveDate: value.effectiveDate,
          });
        } else {
          this.remember(key, value, nowMs + TODAY_TTL_MS);
        }
      }),
    );
    if (fetched.length > 0) {
      try {
        await db.insert(schema.fxRate).values(fetched).onConflictDoNothing();
      } catch {
        // Losing the stored copy only costs a refetch after a restart.
      }
    }
    return result;
  }

  private remember(key: string, value: EcbRate | null, expiresAt: number) {
    if (this.memory.size >= MEMORY_LIMIT && !this.memory.has(key)) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, { value, expiresAt });
  }
}

// The process-wide cache the app uses (the Reports page).
export const fxRateCache = new FxRateCache();
