import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import type { EcbRate } from "./fx";
import { FxRateCache, rateCacheKey, type RateRequest } from "./fx-cache";

// The FX rate cache behind the Reports page (#5689): settled days are kept
// for good (memory + fx_rate), today's rate and "no rate" only briefly, and
// a failed lookup not at all.

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.fxRate);
});

function harness(answers: Record<string, EcbRate | null | Error>) {
  const calls: string[] = [];
  let clock = new Date("2026-11-24T12:00:00Z");
  const source = async ({ date, from, to }: RateRequest) => {
    const key = rateCacheKey(date.toISOString().slice(0, 10), from, to);
    calls.push(key);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  const make = () => new FxRateCache({ source, now: () => clock });
  return {
    calls,
    make,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const rate = (value: string, effectiveDate: string): EcbRate => ({
  rate: value,
  effectiveDate,
  source: "ecb",
});

const req = (day: string, from = "USD", to = "EUR"): RateRequest => ({
  date: new Date(`${day}T00:00:00Z`),
  from,
  to,
});

describe("FxRateCache", () => {
  it("stores a settled day's rate, with the effective day Frankfurter answered with", async () => {
    // Saturday 2026-05-16 is answered with Friday's rate.
    const h = harness({ "2026-05-16|USD|EUR": rate("0.9188", "2026-05-15") });
    const cache = h.make();
    const rates = await cache.getRates(db, [req("2026-05-16"), req("2026-05-16")]);
    expect(rates.get("2026-05-16|USD|EUR")).toEqual(rate("0.9188", "2026-05-15"));
    expect(h.calls).toEqual(["2026-05-16|USD|EUR"]);
    expect(await db.select().from(schema.fxRate)).toMatchObject([
      { rateDate: "2026-05-16", base: "USD", quote: "EUR", rate: "0.9188", effectiveDate: "2026-05-15" },
    ]);

    await cache.getRates(db, [req("2026-05-16")]);
    await h.make().getRates(db, [req("2026-05-16")]);
    expect(h.calls).toHaveLength(1);
  });

  it("keeps today's rate in memory for an hour only, never in the table", async () => {
    const h = harness({ "2026-11-24|USD|EUR": rate("0.9301", "2026-11-23") });
    const cache = h.make();
    await cache.getRates(db, [req("2026-11-24")]);
    await cache.getRates(db, [req("2026-11-24")]);
    expect(h.calls).toHaveLength(1);
    expect(await db.select().from(schema.fxRate)).toEqual([]);
    h.advance(61 * 60 * 1000);
    await cache.getRates(db, [req("2026-11-24")]);
    expect(h.calls).toHaveLength(2);
  });

  it("remembers a pair with no rate for ten minutes, without storing it", async () => {
    const h = harness({});
    const cache = h.make();
    const rates = await cache.getRates(db, [req("2026-03-02", "XAF")]);
    expect(rates.get("2026-03-02|XAF|EUR")).toBeNull();
    await cache.getRates(db, [req("2026-03-02", "XAF")]);
    expect(h.calls).toHaveLength(1);
    expect(await db.select().from(schema.fxRate)).toEqual([]);
    h.advance(11 * 60 * 1000);
    await cache.getRates(db, [req("2026-03-02", "XAF")]);
    expect(h.calls).toHaveLength(2);
  });

  it("doesn't cache a failed lookup: it is left out and asked again next time", async () => {
    const h = harness({ "2026-03-02|USD|EUR": new Error("frankfurter is down") });
    const cache = h.make();
    const rates = await cache.getRates(db, [req("2026-03-02")]);
    expect(rates.has("2026-03-02|USD|EUR")).toBe(false);
    await cache.getRates(db, [req("2026-03-02")]);
    expect(h.calls).toHaveLength(2);
  });

  it("reads only the pairs it was asked for from the table", async () => {
    const h = harness({
      "2026-01-05|USD|EUR": rate("0.95", "2026-01-05"),
      "2026-01-05|GBP|EUR": rate("1.18", "2026-01-05"),
      "2026-01-06|GBP|EUR": rate("1.19", "2026-01-06"),
    });
    await h.make().getRates(db, [req("2026-01-05"), req("2026-01-05", "GBP"), req("2026-01-06", "GBP")]);
    expect(h.calls).toHaveLength(3);
    // A new process asking for USD on the 6th (stored for GBP only) fetches it.
    const fresh = h.make();
    const rates = await fresh.getRates(db, [req("2026-01-05", "GBP"), req("2026-01-06")]);
    expect(rates.get("2026-01-05|GBP|EUR")?.rate).toBe("1.18");
    expect(rates.get("2026-01-06|USD|EUR")).toBeNull();
    expect(h.calls.slice(3)).toEqual(["2026-01-06|USD|EUR"]);
  });
});
