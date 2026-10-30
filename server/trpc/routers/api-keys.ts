import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/api-keys";

import { createTRPCRouter, permissionProcedure } from "../init";

// Settings -> API keys. Keys are minted in, and bound to, the active business
// and act as the member who made them. Managing keys is a browser-only action:
// a key that could mint or revoke keys would outlive its own revocation.
const manageKeys = permissionProcedure("apiKeys.manage").use(({ ctx, next }) => {
  if (ctx.apiKey) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API keys can't manage API keys",
    });
  }
  return next({ ctx });
});

export const apiKeysRouter = createTRPCRouter({
  list: manageKeys.query(({ ctx }) => listApiKeys(getDb(), ctx.businessId)),

  // Returns the plaintext key. It is never stored or shown again.
  create: manageKeys
    .input(
      z.object({
        name: z.string().trim().min(1, "Give the key a name").max(80),
        scope: z.enum(["read", "write"]),
      }),
    )
    .mutation(({ ctx, input }) =>
      createApiKey(getDb(), {
        businessId: ctx.businessId,
        userId: ctx.session.user.id,
        name: input.name,
        scope: input.scope,
      }),
    ),

  revoke: manageKeys
    .input(z.object({ keyId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokeApiKey(getDb(), ctx.businessId, input.keyId);
      if (!revoked) {
        throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
      }
      return { keyId: input.keyId };
    }),
});
