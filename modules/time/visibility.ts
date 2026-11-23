import type { Permission } from "@/modules/authz";

// Time entries carry the internal cost frozen at entry time, which is
// margin-sensitive. Like the per-client member rates (clients router), it is
// only shown to callers who may view profit: the tRPC time router (and so
// MCP) and the REST API all pass entries through here (#3610, #5583).
const INTERNAL_COST_FIELDS = ["internalCostMinor", "internalCostCurrency"] as const;

export function hideInternalCost<T extends object>(
  entry: T,
  permissions: ReadonlySet<Permission>,
): T {
  if (permissions.has("reports.viewProfit")) return entry;
  const copy = { ...entry } as Record<string, unknown>;
  for (const field of INTERNAL_COST_FIELDS) delete copy[field];
  return copy as T;
}

export function hideInternalCostOrNull<T extends object>(
  entry: T | null,
  permissions: ReadonlySet<Permission>,
): T | null {
  return entry ? hideInternalCost(entry, permissions) : null;
}
