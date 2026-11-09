import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { schema } from "@/db";

import { MAX_TAGS_PER_EXPENSE, TAG_COLORS, type TagColor } from "./tag-options";

// Expense tags (#4395). Every function takes the caller's businessId and
// applies it to every query: a tag id from another business behaves exactly
// like a missing one.

export { MAX_TAGS_PER_EXPENSE, TAG_COLORS, type TagColor };

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, "Give the tag a name")
  .max(50, "Keep tag names under 50 characters");

export const tagInputSchema = z.object({
  name: tagNameSchema,
  color: z.enum(TAG_COLORS).default("gray"),
});
export type TagInput = z.input<typeof tagInputSchema>;

export const tagIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_TAGS_PER_EXPENSE, `An expense can carry up to ${MAX_TAGS_PER_EXPENSE} tags`);

export type ExpenseTag = {
  id: string;
  name: string;
  color: TagColor;
};

// A name clash inside one business (names are unique ignoring case).
export class TagNameTakenError extends Error {
  constructor(name: string) {
    super(`A tag called "${name}" already exists`);
    this.name = "TagNameTakenError";
  }
}

// A tag id that isn't this business's.
export class UnknownTagError extends Error {
  constructor() {
    super("One of those tags doesn't exist");
    this.name = "UnknownTagError";
  }
}

const tagColumns = {
  id: schema.expenseTag.id,
  name: schema.expenseTag.name,
  color: schema.expenseTag.color,
};

function asTag(row: { id: string; name: string; color: string }): ExpenseTag {
  const color = (TAG_COLORS as readonly string[]).includes(row.color)
    ? (row.color as TagColor)
    : "gray";
  return { id: row.id, name: row.name, color };
}

function isUniqueViolation(error: unknown): boolean {
  // node-postgres and PGlite both surface the SQLSTATE as `code`; drizzle
  // may wrap it in `cause`.
  const codeOf = (value: unknown) =>
    value && typeof value === "object" && "code" in value
      ? (value as { code: unknown }).code
      : undefined;
  return (
    codeOf(error) === "23505" ||
    codeOf((error as { cause?: unknown } | null)?.cause) === "23505"
  );
}

// Every tag, alphabetical, with how many expenses carry it.
export async function listTags(db: Db, businessId: string) {
  const rows = await db
    .select({ ...tagColumns, expenseCount: count(schema.expenseTagLink.expenseId) })
    .from(schema.expenseTag)
    .leftJoin(
      schema.expenseTagLink,
      eq(schema.expenseTagLink.tagId, schema.expenseTag.id),
    )
    .where(eq(schema.expenseTag.businessId, businessId))
    .groupBy(schema.expenseTag.id)
    .orderBy(asc(sql`lower(${schema.expenseTag.name})`));
  return rows.map((row) => ({ ...asTag(row), expenseCount: Number(row.expenseCount) }));
}

export async function createTag(db: Db, businessId: string, input: TagInput) {
  const data = tagInputSchema.parse(input);
  try {
    const [created] = await db
      .insert(schema.expenseTag)
      .values({ businessId, name: data.name, color: data.color })
      .returning(tagColumns);
    return asTag(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw new TagNameTakenError(data.name);
    throw error;
  }
}

export async function updateTag(
  db: Db,
  businessId: string,
  tagId: string,
  input: TagInput,
) {
  const data = tagInputSchema.parse(input);
  try {
    const [updated] = await db
      .update(schema.expenseTag)
      .set({ name: data.name, color: data.color, updatedAt: new Date() })
      .where(
        and(
          eq(schema.expenseTag.businessId, businessId),
          eq(schema.expenseTag.id, tagId),
        ),
      )
      .returning(tagColumns);
    return updated ? asTag(updated) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TagNameTakenError(data.name);
    throw error;
  }
}

// Deleting a tag takes it off its expenses (the links cascade); the expenses
// themselves are untouched.
export async function deleteTag(db: Db, businessId: string, tagId: string) {
  const [deleted] = await db
    .delete(schema.expenseTag)
    .where(
      and(
        eq(schema.expenseTag.businessId, businessId),
        eq(schema.expenseTag.id, tagId),
      ),
    )
    .returning(tagColumns);
  return deleted ? asTag(deleted) : null;
}

// Tag ids for these names, creating any that don't exist yet (matched
// ignoring case, so "Travel" finds "travel"). Used by MCP and anywhere a
// caller speaks in names. Returns ids in the order the names were given,
// duplicates removed.
export async function ensureTagsByName(
  db: Db,
  businessId: string,
  names: string[],
): Promise<ExpenseTag[]> {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = tagNameSchema.parse(raw);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(name);
  }
  if (wanted.length === 0) return [];

  const findExisting = async () => {
    const rows = await db
      .select(tagColumns)
      .from(schema.expenseTag)
      .where(
        and(
          eq(schema.expenseTag.businessId, businessId),
          inArray(
            sql`lower(${schema.expenseTag.name})`,
            wanted.map((name) => name.toLowerCase()),
          ),
        ),
      );
    return new Map(rows.map((row) => [row.name.toLowerCase(), asTag(row)]));
  };

  let existing = await findExisting();
  const missing = wanted.filter((name) => !existing.has(name.toLowerCase()));
  if (missing.length > 0) {
    // ON CONFLICT DO NOTHING: a concurrent caller creating the same name is
    // fine, we read it back below.
    await db
      .insert(schema.expenseTag)
      .values(missing.map((name) => ({ businessId, name })))
      .onConflictDoNothing();
    existing = await findExisting();
  }
  return wanted.map((name) => existing.get(name.toLowerCase())!);
}

// Replace the expense's tags with exactly these. Every id must belong to the
// business, or nothing changes.
export async function setExpenseTags(
  db: Db,
  businessId: string,
  expenseId: string,
  tagIds: string[],
) {
  const ids = [...new Set(tagIds)];
  tagIdsSchema.parse(ids);
  if (ids.length > 0) {
    const owned = await db
      .select({ id: schema.expenseTag.id })
      .from(schema.expenseTag)
      .where(
        and(
          eq(schema.expenseTag.businessId, businessId),
          inArray(schema.expenseTag.id, ids),
        ),
      );
    if (owned.length !== ids.length) throw new UnknownTagError();
  }
  await db
    .delete(schema.expenseTagLink)
    .where(
      and(
        eq(schema.expenseTagLink.businessId, businessId),
        eq(schema.expenseTagLink.expenseId, expenseId),
      ),
    );
  if (ids.length > 0) {
    await db
      .insert(schema.expenseTagLink)
      .values(ids.map((tagId) => ({ businessId, expenseId, tagId })));
  }
}

// Tags for each of these expenses, alphabetical within an expense.
export async function tagsForExpenses(
  db: Db,
  businessId: string,
  expenseIds: string[],
): Promise<Map<string, ExpenseTag[]>> {
  const byExpense = new Map<string, ExpenseTag[]>();
  if (expenseIds.length === 0) return byExpense;
  const rows = await db
    .select({ expenseId: schema.expenseTagLink.expenseId, ...tagColumns })
    .from(schema.expenseTagLink)
    .innerJoin(
      schema.expenseTag,
      eq(schema.expenseTag.id, schema.expenseTagLink.tagId),
    )
    .where(
      and(
        eq(schema.expenseTagLink.businessId, businessId),
        inArray(schema.expenseTagLink.expenseId, expenseIds),
      ),
    )
    .orderBy(asc(sql`lower(${schema.expenseTag.name})`));
  for (const row of rows) {
    const list = byExpense.get(row.expenseId) ?? [];
    list.push(asTag(row));
    byExpense.set(row.expenseId, list);
  }
  return byExpense;
}
