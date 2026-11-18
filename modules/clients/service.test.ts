import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import {
  addNote,
  archiveClient,
  createClient,
  getClient,
  importClients,
  listActivity,
  listClients,
  unarchiveClient,
  updateClient,
} from "./service";

// Integration suite on PGlite: real Postgres, real checked-in migrations.
// This is the required proof that cross-business access is
// denied at the data layer, not just hidden by the UI.

let pglite: PGlite;
let db: Db;

let businessA: { id: string };
let businessB: { id: string };
const userA = "user-a";
const userB = "user-b";

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());

  [businessA] = await db
    .insert(schema.business)
    .values({ name: "Alpha Studio", currency: "GBP" })
    .returning();
  [businessB] = await db
    .insert(schema.business)
    .values({ name: "Beta Works", currency: "CZK" })
    .returning();
  await db.insert(schema.user).values([
    { id: userA, name: "Ada", email: "ada@alpha.test" },
    { id: userB, name: "Ben", email: "ben@beta.test" },
  ]);
  await db.insert(schema.businessMember).values([
    { businessId: businessA.id, userId: userA, role: "owner" },
    { businessId: businessB.id, userId: userB, role: "owner" },
  ]);
});

afterAll(async () => {
  await pglite.close();
});

describe("clients service - cross-business isolation", () => {
  it("denies every operation on another business's client", async () => {
    const intruderTarget = await createClient(db, businessB.id, userB, {
      name: "Beta's client",
      contacts: [],
    });

    // Business A holds a real, existing client id belonging to B. Every
    // operation must behave as if the record does not exist.
    expect(await getClient(db, businessA.id, intruderTarget.id)).toBeNull();
    expect(
      await updateClient(db, businessA.id, userA, intruderTarget.id, {
        name: "hijacked",
        contacts: [],
      }),
    ).toBeNull();
    expect(
      await archiveClient(db, businessA.id, userA, intruderTarget.id),
    ).toBeNull();
    expect(
      await addNote(db, businessA.id, userA, intruderTarget.id, "intrusion"),
    ).toBeNull();
    expect(await listActivity(db, businessA.id, intruderTarget.id)).toEqual([]);

    // And the record is untouched for its real owner.
    const untouched = await getClient(db, businessB.id, intruderTarget.id);
    expect(untouched?.name).toBe("Beta's client");
    expect(untouched?.archivedAt).toBeNull();
  });

  it("lists only the caller's clients", async () => {
    await createClient(db, businessA.id, userA, {
      name: "Alpha client one",
      contacts: [],
    });

    const forA = await listClients(db, businessA.id);
    const forB = await listClients(db, businessB.id);

    expect(forA.every((c) => c.businessId === businessA.id)).toBe(true);
    expect(forB.every((c) => c.businessId === businessB.id)).toBe(true);
    expect(forA.some((c) => c.name === "Beta's client")).toBe(false);
  });
});

describe("clients service - bulk import", () => {
  it("creates new clients, skips existing names case-insensitively, and is re-runnable", async () => {
    await createClient(db, businessA.id, userA, {
      name: "Harbor & Co",
      contacts: [],
    });

    const first = await importClients(db, businessA.id, userA, [
      { name: "HARBOR & CO", contacts: [] },
      {
        name: "Brightfern Ltd",
        contacts: [{ name: "Iris", email: "iris@brightfern.test" }],
        vatNumber: "GB987654321",
      },
      { name: "Brightfern Ltd", contacts: [] },
    ]);
    expect(first.created).toBe(1);
    expect(first.skipped).toEqual(["HARBOR & CO", "Brightfern Ltd"]);

    const imported = await getClientByName(businessA.id, "Brightfern Ltd");
    expect(imported?.vatNumber).toBe("GB987654321");

    // Re-running the same import creates nothing.
    const second = await importClients(db, businessA.id, userA, [
      { name: "Brightfern Ltd", contacts: [] },
    ]);
    expect(second.created).toBe(0);

    // The other business is untouched and could import the same names.
    const forB = await listClients(db, businessB.id);
    expect(forB.some((c) => c.name === "Brightfern Ltd")).toBe(false);
  });
});

async function getClientByName(businessId: string, name: string) {
  const all = await listClients(db, businessId);
  return all.find((c) => c.name === name) ?? null;
}

describe("clients service - lifecycle", () => {
  it("creates, updates, archives and records the activity thread", async () => {
    const created = await createClient(db, businessA.id, userA, {
      name: "Studio Brightwood",
      contacts: [{ name: "Mara", email: "mara@brightwood.test" }],
      notes: "Met at the spring meetup",
    });
    expect(created.archivedAt).toBeNull();

    const updated = await updateClient(db, businessA.id, userA, created.id, {
      name: "Studio Brightwood",
      contacts: [
        { name: "Mara", email: "mara@brightwood.test", role: "CTO" },
      ],
    });
    expect(updated?.contacts).toEqual([
      { name: "Mara", email: "mara@brightwood.test", role: "CTO" },
    ]);
    expect(updated?.notes).toBeNull();

    await addNote(db, businessA.id, userA, created.id, "Sent the proposal");

    const archived = await archiveClient(db, businessA.id, userA, created.id);
    expect(archived?.archivedAt).toBeInstanceOf(Date);

    // Archived clients leave the default list but not the archive view.
    const defaultList = await listClients(db, businessA.id);
    expect(defaultList.some((c) => c.id === created.id)).toBe(false);
    const fullList = await listClients(db, businessA.id, {
      includeArchived: true,
    });
    expect(fullList.some((c) => c.id === created.id)).toBe(true);

    const restored = await unarchiveClient(db, businessA.id, userA, created.id);
    expect(restored?.archivedAt).toBeNull();

    const thread = await listActivity(db, businessA.id, created.id);
    expect(thread.map((a) => a.type)).toEqual([
      "client_unarchived",
      "client_archived",
      "note",
      "client_updated",
      "client_created",
    ]);
    const note = thread.find((a) => a.type === "note");
    expect(note?.payload).toEqual({ text: "Sent the proposal" });
    expect(note?.userId).toBe(userA);
  });
});

describe("clients service - search", () => {
  it("filters by name case-insensitively and stays business-scoped", async () => {
    await createClient(db, businessA.id, userA, {
      name: "Northwind Trading",
      contacts: [],
    });
    await createClient(db, businessA.id, userA, {
      name: "Southgate Media",
      contacts: [],
    });
    // A same-named client in another business must never leak into A's
    // search results.
    await createClient(db, businessB.id, userB, {
      name: "Northwind Trading",
      contacts: [],
    });

    const hits = await listClients(db, businessA.id, { search: "northwind" });
    expect(hits.map((c) => c.name)).toEqual(["Northwind Trading"]);
    expect(hits.every((c) => c.businessId === businessA.id)).toBe(true);

    // A substring in the middle of the name still matches.
    const partial = await listClients(db, businessA.id, { search: "gate" });
    expect(partial.map((c) => c.name)).toContain("Southgate Media");

    // No match returns an empty list, not everything.
    expect(await listClients(db, businessA.id, { search: "zzzzz" })).toEqual(
      [],
    );
  });

  it("respects the archived scope while searching", async () => {
    const created = await createClient(db, businessA.id, userA, {
      name: "Archivable Anchors",
      contacts: [],
    });
    await archiveClient(db, businessA.id, userA, created.id);

    // Archived clients are excluded from the default search...
    expect(
      await listClients(db, businessA.id, { search: "Archivable" }),
    ).toEqual([]);
    // ...but included when archived are requested.
    const withArchived = await listClients(db, businessA.id, {
      search: "Archivable",
      includeArchived: true,
    });
    expect(withArchived.map((c) => c.name)).toContain("Archivable Anchors");
  });
});

describe("clients service - structured postal address", () => {
  it("stores it normalised, keeps it when an update leaves it out, clears it on null", async () => {
    const created = await createClient(db, businessA.id, userA, {
      name: "Harbour Partners",
      contacts: [],
      address: "12 Harbour Street\nBristol BS1 4QA",
      postalAddress: {
        street: " 12 Harbour Street ",
        city: "Bristol",
        postcode: "BS1 4QA",
        region: "",
        country: "GB",
      },
    });
    expect(created.postalAddress).toEqual({
      street: "12 Harbour Street",
      city: "Bristol",
      postcode: "BS1 4QA",
      region: null,
      country: "GB",
    });

    // An older caller that doesn't know the field keeps the stored value.
    const renamed = await updateClient(db, businessA.id, userA, created.id, {
      name: "Harbour Partners Ltd",
      contacts: [],
      address: "12 Harbour Street\nBristol BS1 4QA",
    });
    expect(renamed?.postalAddress?.city).toBe("Bristol");

    const cleared = await updateClient(db, businessA.id, userA, created.id, {
      name: "Harbour Partners Ltd",
      contacts: [],
      postalAddress: null,
    });
    expect(cleared?.postalAddress).toBeNull();
    // The free-text address is independent of it.
    expect(cleared?.address).toBeNull();
  });

  it("defaults to no structured address", async () => {
    const created = await createClient(db, businessA.id, userA, {
      name: "Plain Address Co",
      contacts: [],
      address: "Somewhere",
    });
    expect(created.postalAddress).toBeNull();
  });
});
