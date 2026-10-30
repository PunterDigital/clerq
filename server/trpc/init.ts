import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { getDb } from "@/db";
import { PERMISSION_META, type Permission } from "@/modules/authz";
import {
  getBusinessSuspension,
  getUserSuspension,
  isPlatformAdmin,
} from "@/modules/platform/service";
import { getAuth, type Session } from "@/server/auth";
import { getActiveMembership, getMembershipIn } from "@/server/membership";

function suspensionMessage(scope: "account" | "business", reason: string | null): string {
  const subject = scope === "account" ? "Your account" : "This business";
  return reason ? `${subject} has been suspended: ${reason}` : `${subject} has been suspended`;
}

// Set when the request was authenticated with an API key rather than a browser
// session (see server/api-keys.ts). The key pins the business it was made in
// and limits read-only keys to queries.
export type ApiKeyPrincipal = {
  id: string;
  businessId: string;
  scope: "read" | "write";
};

export type TRPCContext = {
  headers: Headers;
  session: Session | null;
  apiKey?: ApiKeyPrincipal;
};

export const createTRPCContext = async (opts: {
  headers: Headers;
}): Promise<TRPCContext> => {
  const session = await getAuth().api.getSession({ headers: opts.headers });
  return {
    headers: opts.headers,
    session: session as Session | null,
  };
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  // Input validation failures arrive as a ZodError wrapped in the TRPCError's
  // cause. By default tRPC stringifies the whole issue array into `message`,
  // which then leaks as raw JSON into any UI that renders `error.message`.
  // Surface the first issue's human-readable message instead, and expose the
  // structured issues under `data.zodError` for forms that want field detail.
  errorFormatter({ shape, error }) {
    if (error.cause instanceof ZodError) {
      const [firstIssue] = error.cause.issues;
      if (firstIssue) {
        return {
          ...shape,
          message: firstIssue.message,
          data: { ...shape.data, zodError: error.cause.issues },
        };
      }
    }
    return shape;
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

// A signed-in caller, by browser session or API key. Not exported: an API key
// may only reach business-scoped procedures (below), never account-level ones.
const sessionProcedure = publicProcedure.use(async ({ ctx, next, type }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first" });
  }
  // A moderation suspension is the lowest gate, below even tenancy: a
  // suspended account can't act anywhere, not even to accept a fresh invite.
  const suspension = await getUserSuspension(getDb(), ctx.session.user.id);
  if (suspension) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: suspensionMessage("account", suspension.reason),
    });
  }
  if (ctx.apiKey?.scope === "read" && type !== "query") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This API key is read-only",
    });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// Account-level procedures (create or switch a business, accept an invite,
// platform admin). Browser sessions only: an API key is bound to one business
// and must not change the account it acts for.
export const authedProcedure = sessionProcedure.use(({ ctx, next }) => {
  if (ctx.apiKey) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API keys can only act inside their business",
    });
  }
  return next({ ctx });
});

// The tenancy boundary: every business-scoped procedure derives business_id
// from the caller's active membership, never from client input. The active
// business is the one the user has switched to (their userActiveBusiness
// pointer), falling back to their oldest membership - see getActiveMembership.
// An API key instead always resolves to the business it was made in.
export const businessProcedure = sessionProcedure.use(async ({ ctx, next }) => {
  const active = ctx.apiKey
    ? await getMembershipIn(ctx.session.user.id, ctx.apiKey.businessId)
    : await getActiveMembership(ctx.session.user.id);
  if (!active) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Create a business first",
    });
  }
  const businessSuspension = await getBusinessSuspension(getDb(), active.businessId);
  if (businessSuspension) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: suspensionMessage("business", businessSuspension.reason),
    });
  }
  return next({
    ctx: {
      ...ctx,
      businessId: active.businessId,
      businessMemberId: active.businessMemberId,
      // The stored role key ("owner".."viewer" or "custom"). Use it only for
      // ownership checks (=== "owner"); for everything else gate on
      // permissions below.
      businessRole: active.role,
      businessRoleId: active.customRoleId,
      roleName: active.roleName,
      // The caller's resolved permissions (role + per-member overrides).
      // Gate on this, never on businessRole directly - a member's individual
      // grants and denies only show up here.
      permissions: active.permissions,
    },
  });
});

// Throws FORBIDDEN unless the permission set holds `permission`. Use inside a
// businessProcedure when a single handler needs more than one permission, or
// when the gate is conditional; otherwise prefer permissionProcedure below.
export function requirePermission(
  permissions: ReadonlySet<Permission>,
  permission: Permission,
): void {
  if (!permissions.has(permission)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You don't have permission to ${PERMISSION_META[permission].label.toLowerCase()}`,
    });
  }
}

// The common case: a procedure that requires exactly one permission. Builds on
// businessProcedure, so it also carries the tenancy boundary and session.
export const permissionProcedure = (permission: Permission) =>
  businessProcedure.use(({ ctx, next }) => {
    requirePermission(ctx.permissions, permission);
    return next({ ctx });
  });

// Platform administration is a separate, cross-tenant capability - it builds
// on authedProcedure (session + not-suspended), never on businessProcedure,
// because a platform admin need not belong to any business at all.
export const platformAdminProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const admin = await isPlatformAdmin(getDb(), ctx.session.user.id);
  if (!admin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Platform admin access required",
    });
  }
  return next({ ctx: { ...ctx, isPlatformAdmin: true as const } });
});
