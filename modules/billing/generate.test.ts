import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  groupTimeEntriesToLines,
  type BillableEntry,
  type FxRateInput,
  type GeneratedLine,
  type GroupingMode,
} from "./generate";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../fixtures/billing/cases/time-to-line.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  expected: {
    cases: {
      case: string;
      grouping: GroupingMode;
      invoiceCurrency: string;
      fxRates?: Record<string, FxRateInput>;
      includeTaskList?: boolean;
      includeNotes?: boolean;
      entries: BillableEntry[];
      lines: GeneratedLine[];
      unpricedEntryIds: string[];
    }[];
    errors: {
      case: string;
      grouping: GroupingMode;
      invoiceCurrency: string;
      entries: BillableEntry[];
      reason: string;
      currencies?: string[];
    }[];
  };
};

describe("time-to-line grouping (fixture: time-to-line.json)", () => {
  it("matches every fixture case exactly", () => {
    for (const c of fixture.expected.cases) {
      const result = groupTimeEntriesToLines({
        entries: c.entries,
        grouping: c.grouping,
        invoiceCurrency: c.invoiceCurrency,
        fxRates: c.fxRates,
        includeTaskList: c.includeTaskList,
        includeNotes: c.includeNotes,
      });
      expect(result.ok, c.case).toBe(true);
      if (result.ok) {
        expect(result.lines, c.case).toEqual(c.lines);
        expect(result.unpricedEntryIds, c.case).toEqual(c.unpricedEntryIds);
      }
    }
  });

  it("returns the fixture error reasons exactly", () => {
    for (const c of fixture.expected.errors) {
      const result = groupTimeEntriesToLines({
        entries: c.entries,
        grouping: c.grouping,
        invoiceCurrency: c.invoiceCurrency,
      });
      expect(result.ok, c.case).toBe(false);
      if (!result.ok) {
        expect(result.reason, c.case).toBe(c.reason);
        if (c.currencies && result.reason === "missing_fx_rates") {
          expect(result.currencies.sort(), c.case).toEqual(
            [...c.currencies].sort(),
          );
        }
      }
    }
  });

  it("rejects malformed FX rate strings before any math", () => {
    expect(() =>
      groupTimeEntriesToLines({
        entries: [
          {
            id: "e1",
            userId: "u1",
            userName: "Shay",
            taskId: "t1",
            taskTitle: "A",
            durationSeconds: 3600,
            rateMinor: 6200,
            rateCurrency: "EUR",
          },
        ],
        grouping: "person_rate",
        invoiceCurrency: "GBP",
        fxRates: { EUR: { rate: "1,15", source: "manual" } },
      }),
    ).toThrow();
  });
});
