import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import {
  createExpense,
  deleteExpense,
  getExpense,
  listExpenses,
  updateExpense,
} from "./service";
import {
  createTag,
  deleteTag,
  ensureTagsByName,
  listTags,
  setExpenseTags,
  TagNameTakenError,
  UnknownTagError,
  updateTag,
} from "./tags";

let pglite: PGlite;
let db: Db;
let business: { id: string };
let other: { id: string };

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());
  [business] = await db
    .insert(schema.business)
    .values({ name: "Tag Studio", currency: "EUR" })
    .returning();
  [other] = await db
    .insert(schema.business)
    .values({ name: "Other Co", currency: "EUR" })
    .returning();
});

afterAll(async () => {
  await pglite.close();
});

function expenseInput(description: string, tagIds?: string[]) {
  return {
    description,
    amountMinor: 1000,
    currency: "EUR",
    incurredAt: new Date("2026-11-01T00:00:00Z"),
    tagIds,
  };
}

describe("expense tags", () => {
  it("creates tags with a default colour and refuses a name clash ignoring case", async () => {
    const tag = await createTag(db, business.id, { name: "  Software " });
    expect(tag).toMatchObject({ name: "Software", color: "gray" });

    await expect(
      createTag(db, business.id, { name: "software", color: "blue" }),
    ).rejects.toBeInstanceOf(TagNameTakenError);

    // The same name is free in another business.
    await expect(
      createTag(db, other.id, { name: "Software" }),
    ).resolves.toMatchObject({ name: "Software" });
  });

  it("refuses an unknown colour", async () => {
    await expect(
      // @ts-expect-error - not one of TAG_COLORS
      createTag(db, business.id, { name: "Odd", color: "#ff00ff" }),
    ).rejects.toThrow();
  });

  it("renames and recolours, and won't touch another business's tag", async () => {
    const tag = await createTag(db, business.id, { name: "Travl" });
    const renamed = await updateTag(db, business.id, tag.id, {
      name: "Travel",
      color: "blue",
    });
    expect(renamed).toMatchObject({ id: tag.id, name: "Travel", color: "blue" });

    expect(
      await updateTag(db, other.id, tag.id, { name: "Hijack", color: "red" }),
    ).toBeNull();
    expect(await deleteTag(db, other.id, tag.id)).toBeNull();

    await expect(
      updateTag(db, business.id, tag.id, { name: "SOFTWARE" }),
    ).rejects.toBeInstanceOf(TagNameTakenError);
  });

  it("tags an expense on create, keeps tags when update omits them, replaces them otherwise", async () => {
    const a = await createTag(db, business.id, { name: "Client A" });
    const b = await createTag(db, business.id, { name: "Billable" });

    const created = await createExpense(
      db,
      business.id,
      expenseInput("Train to client", [a.id, b.id]),
    );
    let read = await getExpense(db, business.id, created.id);
    expect(read?.tags.map((t) => t.name)).toEqual(["Billable", "Client A"]);

    // Omitted tagIds: tags stay.
    await updateExpense(db, business.id, created.id, expenseInput("Train"));
    read = await getExpense(db, business.id, created.id);
    expect(read?.tags.map((t) => t.name)).toEqual(["Billable", "Client A"]);

    // An explicit list replaces; an empty one clears.
    await updateExpense(db, business.id, created.id, expenseInput("Train", [b.id]));
    read = await getExpense(db, business.id, created.id);
    expect(read?.tags.map((t) => t.name)).toEqual(["Billable"]);

    await updateExpense(db, business.id, created.id, expenseInput("Train", []));
    read = await getExpense(db, business.id, created.id);
    expect(read?.tags).toEqual([]);
  });

  it("refuses another business's tag id and leaves nothing behind", async () => {
    const foreign = await createTag(db, other.id, { name: "Foreign" });
    await expect(
      createExpense(db, business.id, expenseInput("Smuggled", [foreign.id])),
    ).rejects.toBeInstanceOf(UnknownTagError);

    // The create rolled back with the bad tag.
    const all = await listExpenses(db, business.id, { search: "Smuggled" });
    expect(all).toEqual([]);

    const mine = await createExpense(db, business.id, expenseInput("Mine"));
    await expect(
      setExpenseTags(db, business.id, mine.id, [foreign.id]),
    ).rejects.toBeInstanceOf(UnknownTagError);
  });

  it("filters the list by any of several tags, alongside status and search", async () => {
    const red = await createTag(db, business.id, { name: "Filter red", color: "red" });
    const green = await createTag(db, business.id, { name: "Filter green", color: "green" });
    const unused = await createTag(db, business.id, { name: "Filter unused" });

    await createExpense(db, business.id, expenseInput("F one", [red.id]));
    await createExpense(db, business.id, expenseInput("F two", [green.id]));
    await createExpense(db, business.id, expenseInput("F three", [red.id, green.id]));
    await createExpense(db, business.id, expenseInput("F none"));

    const names = async (tagIds: string[], search = "F ") =>
      (await listExpenses(db, business.id, { tagIds, search }))
        .map((e) => e.description)
        .sort();

    expect(await names([red.id])).toEqual(["F one", "F three"]);
    expect(await names([red.id, green.id])).toEqual(["F one", "F three", "F two"]);
    expect(await names([unused.id])).toEqual([]);
    // No tag filter: everything, each row with its tags.
    const rows = await listExpenses(db, business.id, { search: "F " });
    expect(rows).toHaveLength(4);
    const three = rows.find((r) => r.description === "F three");
    expect(three?.tags.map((t) => t.name)).toEqual(["Filter green", "Filter red"]);
    expect(await names([red.id], "three")).toEqual(["F three"]);

    // Another business's filter sees nothing of this one.
    expect(await listExpenses(db, other.id, { tagIds: [red.id] })).toEqual([]);
  });

  it("deleting a tag takes it off its expenses, never the expenses", async () => {
    const tag = await createTag(db, business.id, { name: "Short-lived" });
    const expense = await createExpense(db, business.id, expenseInput("Keeps", [tag.id]));

    expect(await deleteTag(db, business.id, tag.id)).toMatchObject({ id: tag.id });
    const read = await getExpense(db, business.id, expense.id);
    expect(read).not.toBeNull();
    expect(read?.tags).toEqual([]);
  });

  it("deleting an expense removes its links but keeps the tag", async () => {
    const tag = await createTag(db, business.id, { name: "Survivor" });
    const expense = await createExpense(db, business.id, expenseInput("Goes", [tag.id]));
    await deleteExpense(db, business.id, expense.id);
    const tags = await listTags(db, business.id);
    expect(tags.find((t) => t.id === tag.id)).toMatchObject({ expenseCount: 0 });
  });

  it("lists tags alphabetically with expense counts", async () => {
    const tags = await listTags(db, business.id);
    const names = tags.map((t) => t.name);
    expect(names).toEqual(
      [...names].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())),
    );
    expect(tags.find((t) => t.name === "Filter red")).toMatchObject({ expenseCount: 2 });
  });

  it("ensureTagsByName reuses existing tags ignoring case and creates the rest", async () => {
    const before = await listTags(db, business.id);
    const tags = await ensureTagsByName(db, business.id, [
      "travel",
      "Brand new",
      "BRAND NEW",
    ]);
    expect(tags.map((t) => t.name)).toEqual(["Travel", "Brand new"]);
    const after = await listTags(db, business.id);
    expect(after.length).toBe(before.length + 1);
    expect(await ensureTagsByName(db, business.id, [])).toEqual([]);
  });
});
