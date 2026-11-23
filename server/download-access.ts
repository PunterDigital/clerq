import { getDb } from "@/db";
import type { Permission } from "@/modules/authz";
import {
  getBusinessSuspension,
  getUserSuspension,
} from "@/modules/platform/service";
import { getActiveMembership } from "@/server/membership";
import { getEffectiveSession } from "@/server/session";

// The gates a browser download route (a plain GET: PDFs, e-invoice XML,
// receipts, the data export) must apply before it reads anything, the same
// ones sessionProcedure + businessProcedure + permissionProcedure apply to
// every tRPC call: a session, no account suspension, a membership, no
// business suspension, and the permission (#5583).
export type DownloadAccess = {
  userId: string;
  businessId: string;
  permissions: ReadonlySet<Permission>;
  // A platform admin viewing the app as this user: reads only.
  impersonating: boolean;
};

export async function resolveDownloadAccess(
  headers: Headers,
  permission: Permission,
): Promise<DownloadAccess | Response> {
  const session = await getEffectiveSession(headers);
  if (!session) {
    return new Response("Sign in first", { status: 401 });
  }
  const db = getDb();
  if (await getUserSuspension(db, session.user.id)) {
    return new Response("Your account has been suspended", { status: 403 });
  }
  const membership = await getActiveMembership(session.user.id);
  if (!membership) {
    return new Response("No business", { status: 403 });
  }
  if (await getBusinessSuspension(db, membership.businessId)) {
    return new Response("This business has been suspended", { status: 403 });
  }
  if (!membership.permissions.has(permission)) {
    return new Response("You don't have permission to do that", { status: 403 });
  }
  return {
    userId: session.user.id,
    businessId: membership.businessId,
    permissions: membership.permissions,
    impersonating: Boolean(session.impersonation),
  };
}

// Downloading an invoice's e-invoice (XML, or a PDF carrying Factur-X)
// marks it as sent, after which it can't be voided (#5042). Only a caller
// who could void it may set that: someone holding invoices.void, acting for
// themselves (not an impersonating admin), not through a read-only API key.
// Anyone else who may read the invoice gets the file without marking it.
export function mayRecordEinvoiceSent(caller: {
  permissions: ReadonlySet<Permission>;
  impersonating: boolean;
  readOnlyKey: boolean;
}): boolean {
  return (
    caller.permissions.has("invoices.void") &&
    !caller.impersonating &&
    !caller.readOnlyKey
  );
}
