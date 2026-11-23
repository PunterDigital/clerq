import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { getDb } from "@/db";
import {
  getBusinessSuspension,
  getUserSuspension,
} from "@/modules/platform/service";
import { getActiveMembership } from "@/server/membership";
import { getEffectiveSession } from "@/server/session";
import type { AuthLoaders } from "@/server/trpc/init";

// Request-scoped reads for React Server Components (#5694). A page render
// calls the RSC tRPC caller several times and the layout checks the same
// session, suspension and membership itself; React's cache() runs each of
// these once per request and hands the same promise to every later caller.
// The scope is one server render, so a suspension or a role change applies
// from the next request on, as before. Outside a render (route handlers,
// /api/trpc, MCP) cache() does not memoize, and those paths don't use this
// module anyway.

// Who is signed in for this request, impersonation applied. Pages and
// layouts use this instead of getEffectiveSession(await headers()).
export const getRequestSession = cache(async () => getEffectiveSession(await headers()));

export const getRequestMembership = cache((userId: string) => getActiveMembership(userId));

const getRequestUserSuspension = cache((userId: string) =>
  getUserSuspension(getDb(), userId),
);

const getRequestBusinessSuspension = cache((businessId: string) =>
  getBusinessSuspension(getDb(), businessId),
);

export { getRequestUserSuspension, getRequestBusinessSuspension };

// What the RSC caller's context hands the tRPC middleware, so its checks
// share the layout's answers instead of querying again per procedure call.
export const requestAuthLoaders: AuthLoaders = {
  userSuspension: getRequestUserSuspension,
  activeMembership: getRequestMembership,
  businessSuspension: getRequestBusinessSuspension,
};
