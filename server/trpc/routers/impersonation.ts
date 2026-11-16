import { TRPCError } from "@trpc/server";

import { getDb } from "@/db";
import { endImpersonation } from "@/modules/platform/impersonation";

import { createTRPCRouter, publicProcedure } from "../init";

// The way out of an impersonation. Built on publicProcedure, not the session
// procedures: those refuse every mutation while impersonating. It only ever
// ends the impersonation on the caller's own session (ctx.session.session is
// the admin's Better Auth session even while the user is swapped).
// Starting one is admin.startImpersonation.
export const impersonationRouter = createTRPCRouter({
  stop: publicProcedure.mutation(async ({ ctx }) => {
    if (!ctx.session || !ctx.impersonation || ctx.apiKey) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You aren't viewing as another user",
      });
    }
    await endImpersonation(getDb(), ctx.impersonation.id, ctx.session.session.id);
    return { targetUserId: ctx.impersonation.targetUserId };
  }),
});
