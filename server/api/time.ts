import type { ApiContext } from "@/server/api/v1";

// Time entries carry the internal cost frozen at entry time, which is
// margin-sensitive. Like the per-client member rates (clients router), the
// API returns it only to keys whose creator may view profit.
const INTERNAL_COST_FIELDS = ["internalCostMinor", "internalCostCurrency"] as const;

export function publicEntry<T extends object>(entry: T, ctx: ApiContext<unknown>): T {
  if (ctx.membership.permissions.has("reports.viewProfit")) return entry;
  const copy = { ...entry } as Record<string, unknown>;
  for (const field of INTERNAL_COST_FIELDS) delete copy[field];
  return copy as T;
}
