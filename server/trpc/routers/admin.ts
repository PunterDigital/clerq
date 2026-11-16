import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import {
  getBusinessDetail,
  getPlatformStats,
  getUserDetail,
  grantPlatformAdmin,
  listBusinesses,
  listQuerySchema,
  listUsers,
  reactivateBusiness,
  reactivateUser,
  revokePlatformAdmin,
  suspendBusiness,
  suspendUser,
} from "@/modules/platform/service";
import {
  listImpersonationsOf,
  startImpersonation,
} from "@/modules/platform/impersonation";

import { createTRPCRouter, platformAdminProcedure } from "../init";

const reasonSchema = z.string().trim().min(1).max(500).optional();

export const adminRouter = createTRPCRouter({
  // Aggregate, non-identifying counts for the overview page.
  stats: platformAdminProcedure.query(() => getPlatformStats(getDb())),

  listUsers: platformAdminProcedure
    .input(listQuerySchema)
    .query(({ input }) => listUsers(getDb(), input)),

  getUser: platformAdminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const user = await getUserDetail(getDb(), input.userId);
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
      }
      const impersonations = await listImpersonationsOf(getDb(), input.userId);
      return { ...user, impersonations };
    }),

  // Read-only support access: view the app as this user (see
  // modules/platform/impersonation.ts). The reason is required and kept in
  // the audit history on the user's page.
  startImpersonation: platformAdminProcedure
    .input(
      z.object({
        userId: z.string(),
        reason: z
          .string()
          .trim()
          .min(1, "Say why you need to view as this user")
          .max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await startImpersonation(getDb(), {
        adminUserId: ctx.session.user.id,
        adminSessionId: ctx.session.session.id,
        targetUserId: input.userId,
        reason: input.reason,
      });
      if (!result.ok) {
        const refusals = {
          not_found: { code: "NOT_FOUND", message: "No such user" },
          self: { code: "FORBIDDEN", message: "You can't view as yourself" },
          platform_admin: {
            code: "FORBIDDEN",
            message: "You can't view as another platform admin",
          },
          suspended: {
            code: "PRECONDITION_FAILED",
            message: "That account is suspended; reactivate it first",
          },
        } as const;
        throw new TRPCError(refusals[result.reason]);
      }
      return { ok: true };
    }),

  suspendUser: platformAdminProcedure
    .input(z.object({ userId: z.string(), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await suspendUser(
        getDb(),
        input.userId,
        ctx.session.user.id,
        input.reason,
      );
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN",
          message:
            result.reason === "not_found"
              ? "No such user"
              : "You can't suspend your own account",
        });
      }
      return { ok: true };
    }),

  reactivateUser: platformAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await reactivateUser(getDb(), input.userId);
      if (!result.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That account isn't suspended",
        });
      }
      return { ok: true };
    }),

  grantAdmin: platformAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await grantPlatformAdmin(getDb(), input.userId, ctx.session.user.id);
      if (!result.ok) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That person is already a platform admin",
        });
      }
      return { ok: true };
    }),

  revokeAdmin: platformAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't remove your own platform admin access",
        });
      }
      const result = await revokePlatformAdmin(getDb(), input.userId);
      if (!result.ok) {
        throw new TRPCError({
          code:
            result.reason === "last_admin" ? "PRECONDITION_FAILED" : "NOT_FOUND",
          message:
            result.reason === "last_admin"
              ? "You can't remove the last platform admin"
              : "That person isn't a platform admin",
        });
      }
      return { ok: true };
    }),

  listBusinesses: platformAdminProcedure
    .input(listQuerySchema)
    .query(({ input }) => listBusinesses(getDb(), input)),

  getBusiness: platformAdminProcedure
    .input(z.object({ businessId: z.string().uuid() }))
    .query(async ({ input }) => {
      const business = await getBusinessDetail(getDb(), input.businessId);
      if (!business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such business" });
      }
      return business;
    }),

  suspendBusiness: platformAdminProcedure
    .input(z.object({ businessId: z.string().uuid(), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await suspendBusiness(
        getDb(),
        input.businessId,
        ctx.session.user.id,
        input.reason,
      );
      if (!result.ok) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such business" });
      }
      return { ok: true };
    }),

  reactivateBusiness: platformAdminProcedure
    .input(z.object({ businessId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const result = await reactivateBusiness(getDb(), input.businessId);
      if (!result.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That business isn't suspended",
        });
      }
      return { ok: true };
    }),
});
