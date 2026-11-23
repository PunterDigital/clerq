import { hideInternalCost } from "@/modules/time/visibility";
import type { ApiContext } from "@/server/api/v1";

// Time entries carry the internal cost frozen at entry time, which is
// margin-sensitive. Like the per-client member rates (clients router), the
// API returns it only to keys whose creator may view profit. The tRPC time
// router strips it too (#5583); this stays as a second guard.
export function publicEntry<T extends object>(entry: T, ctx: ApiContext<unknown>): T {
  return hideInternalCost(entry, ctx.membership.permissions);
}
