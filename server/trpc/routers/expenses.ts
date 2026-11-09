import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import {
  ReceiptScanError,
  scanReceipt,
} from "@/modules/expenses/ocr";
import {
  createExpense,
  deleteExpense,
  expenseInputSchema,
  expenseStatusSchema,
  getExpense,
  listExpenses,
  setExpenseStatus,
  updateExpense,
} from "@/modules/expenses/service";
import {
  createTag,
  deleteTag,
  ensureTagsByName,
  listTags,
  MAX_TAGS_PER_EXPENSE,
  TagNameTakenError,
  tagIdsSchema,
  tagInputSchema,
  tagNameSchema,
  UnknownTagError,
  updateTag,
} from "@/modules/expenses/tags";

import { createTRPCRouter, permissionProcedure } from "../init";

const expenseIdInput = z.object({ expenseId: z.string().uuid() });

// Scanning only accepts the image formats a vision model can read - PDFs are
// excluded here even though they're valid receipts elsewhere in the form.
const scanReceiptInput = z.object({
  dataUrl: z
    .string()
    .regex(
      /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/,
      "Scanning supports PNG or JPEG images",
    )
    .max(2_000_000, "Receipt is too large to scan - keep it under ~1.5MB"),
  mimeType: z.enum(["image/png", "image/jpeg"]),
});

// An expense id from another business is indistinguishable from a missing
// record: the service scopes every query by ctx.businessId.
function found<T>(row: T | null): T {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such expense" });
  }
  return row;
}

// Tag errors from the service as tRPC errors: a name clash is a CONFLICT, a
// tag id from another business a BAD_REQUEST (like a missing record).
async function tagCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TagNameTakenError) {
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    }
    if (error instanceof UnknownTagError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

const tagIdInput = z.object({ tagId: z.string().uuid() });

// Expense tags (#4395). Anyone who can record or edit expenses can make a new
// tag while tagging; renaming, recolouring and deleting a tag changes every
// expense that carries it, so that needs expenses.manageTags (owner/admin).
const tagsRouter = createTRPCRouter({
  list: permissionProcedure("expenses.view").query(async ({ ctx }) => ({
    tags: await listTags(getDb(), ctx.businessId),
    canManage: ctx.permissions.has("expenses.manageTags"),
    canCreate:
      ctx.permissions.has("expenses.create") ||
      ctx.permissions.has("expenses.edit") ||
      ctx.permissions.has("expenses.manageTags"),
  })),

  create: permissionProcedure("expenses.view")
    .input(tagInputSchema)
    .mutation(({ ctx, input }) => {
      const p = ctx.permissions;
      if (
        !p.has("expenses.create") &&
        !p.has("expenses.edit") &&
        !p.has("expenses.manageTags")
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to create expense tags",
        });
      }
      return tagCall(() => createTag(getDb(), ctx.businessId, input));
    }),

  // Ids for these names, creating the missing ones (MCP speaks in names).
  ensure: permissionProcedure("expenses.create")
    .input(z.object({ names: z.array(tagNameSchema).max(MAX_TAGS_PER_EXPENSE) }))
    .mutation(({ ctx, input }) =>
      tagCall(() => ensureTagsByName(getDb(), ctx.businessId, input.names)),
    ),

  update: permissionProcedure("expenses.manageTags")
    .input(tagIdInput.extend({ data: tagInputSchema }))
    .mutation(async ({ ctx, input }) => {
      const tag = await tagCall(() =>
        updateTag(getDb(), ctx.businessId, input.tagId, input.data),
      );
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "No such tag" });
      return tag;
    }),

  delete: permissionProcedure("expenses.manageTags")
    .input(tagIdInput)
    .mutation(async ({ ctx, input }) => {
      const tag = await deleteTag(getDb(), ctx.businessId, input.tagId);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "No such tag" });
      return tag;
    }),
});

export const expensesRouter = createTRPCRouter({
  tags: tagsRouter,

  list: permissionProcedure("expenses.view")
    .input(
      z
        .object({
          status: expenseStatusSchema.optional(),
          search: z.string().optional(),
          // Match any of these tags.
          tagIds: tagIdsSchema.optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listExpenses(getDb(), ctx.businessId, {
        status: input?.status,
        search: input?.search,
        tagIds: input?.tagIds,
      }),
    ),

  get: permissionProcedure("expenses.view")
    .input(expenseIdInput)
    .query(async ({ ctx, input }) =>
      found(await getExpense(getDb(), ctx.businessId, input.expenseId)),
    ),

  create: permissionProcedure("expenses.create")
    .input(expenseInputSchema)
    .mutation(({ ctx, input }) =>
      tagCall(() => createExpense(getDb(), ctx.businessId, input)),
    ),

  // Read a receipt image with OpenRouter and return suggested fields for the
  // form to pre-fill. Gated on expenses.create: scanning is a shortcut to
  // creating an expense. Nothing is persisted here - the user reviews first.
  scanReceipt: permissionProcedure("expenses.create")
    .input(scanReceiptInput)
    .mutation(async ({ input }) => {
      try {
        return await scanReceipt(input);
      } catch (error) {
        if (error instanceof ReceiptScanError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),

  update: permissionProcedure("expenses.edit")
    .input(expenseIdInput.extend({ data: expenseInputSchema }))
    .mutation(async ({ ctx, input }) =>
      found(
        await tagCall(() =>
          updateExpense(getDb(), ctx.businessId, input.expenseId, input.data),
        ),
      ),
    ),

  setStatus: permissionProcedure("expenses.approve")
    .input(expenseIdInput.extend({ status: expenseStatusSchema }))
    .mutation(async ({ ctx, input }) =>
      found(
        await setExpenseStatus(
          getDb(),
          ctx.businessId,
          input.expenseId,
          input.status,
        ),
      ),
    ),

  delete: permissionProcedure("expenses.delete")
    .input(expenseIdInput)
    .mutation(async ({ ctx, input }) =>
      found(await deleteExpense(getDb(), ctx.businessId, input.expenseId)),
    ),
});
