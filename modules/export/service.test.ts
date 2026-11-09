import { PGlite } from "@electric-sql/pglite";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import {
  EXPORT_EXEMPT_TABLES,
  EXPORT_ENTITIES,
  EXPORT_FORMAT_VERSION,
  EXPORT_KIND,
  exportBusinessData,
  exportedTableNames,
} from "./service";

// Integration suite on PGlite (real Postgres, real checked-in migrations),
// like the other module suites. It proves three things the "export everything"
// capability promises:
//   1. completeness  - every business-scoped domain table is in the export,
//      asserted structurally against the schema so a new table can't slip out;
//   2. scoping       - the export contains only the caller's business data;
//   3. portability   - the file carries the documented format metadata.

// Every table in the schema, and the subset that carries business_id - the
// same reflection db/schema.test.ts uses to enforce the tenancy convention.
const allTables = Object.values(schema).filter((value) => is(value, PgTable));

function businessScopedTableNames(): string[] {
  return allTables
    .filter((table) =>
      Object.values(getTableColumns(table)).some(
        (column) => column.name === "business_id",
      ),
    )
    .map((table) => getTableName(table));
}

let pglite: PGlite;
let db: Db;

// A business seeded with exactly one row in every exported collection, plus the
// fingerprints (unique ids/strings) that must never appear in another
// business's export.
type SeededBusiness = {
  businessId: string;
  clientId: string;
  fingerprints: string[];
};

// Insert one row into every business-scoped table for `slug`, in FK order.
// Returns the ids that uniquely identify this business's data so a scoping
// test can assert none of them leak into another business's export.
async function seedFullBusiness(
  label: string,
  slug: string,
  currency: string,
): Promise<SeededBusiness> {
  const [biz] = await db
    .insert(schema.business)
    .values({ name: label, currency })
    .returning();

  const ownerId = `${slug}-owner`;
  const memberId = `${slug}-member`;
  await db.insert(schema.user).values([
    { id: ownerId, name: `${label} Owner`, email: `${ownerId}@t.dev` },
    { id: memberId, name: `${label} Member`, email: `${memberId}@t.dev` },
  ]);

  await db
    .insert(schema.businessMember)
    .values({ businessId: biz.id, userId: ownerId, role: "owner" });
  const [normalMember] = await db
    .insert(schema.businessMember)
    .values({ businessId: biz.id, userId: memberId, role: "member" })
    .returning();

  const [role] = await db
    .insert(schema.businessRole)
    .values({
      businessId: biz.id,
      name: `${label} Custom Role`,
      permissions: ["clients.view"],
    })
    .returning();

  const [permission] = await db
    .insert(schema.businessMemberPermission)
    .values({
      businessId: biz.id,
      businessMemberId: normalMember.id,
      permission: "clients.create",
      effect: "grant",
    })
    .returning();

  const [invitation] = await db
    .insert(schema.businessInvitation)
    .values({
      businessId: biz.id,
      email: `invitee-${slug}@t.dev`,
      role: "member",
      token: `token-${slug}`,
      invitedByUserId: ownerId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();

  const [client] = await db
    .insert(schema.client)
    .values({ businessId: biz.id, name: `${label} Client`, contacts: [] })
    .returning();

  const [rate] = await db
    .insert(schema.clientMemberRate)
    .values({
      businessId: biz.id,
      clientId: client.id,
      userId: memberId,
      billRateMinor: 10_000,
      billRateCurrency: currency,
    })
    .returning();

  const [project] = await db
    .insert(schema.project)
    .values({ businessId: biz.id, clientId: client.id, name: `${label} Project` })
    .returning();

  const [task] = await db
    .insert(schema.task)
    .values({ businessId: biz.id, projectId: project.id, title: `${label} Task` })
    .returning();

  const [timeEntry] = await db
    .insert(schema.timeEntry)
    .values({
      businessId: biz.id,
      taskId: task.id,
      userId: memberId,
      startedAt: new Date(),
      endedAt: new Date(),
      durationSeconds: 3600,
    })
    .returning();

  await db
    .insert(schema.invoiceSequence)
    .values({ businessId: biz.id, year: 2026, nextNumber: 2 });

  const [invoice] = await db
    .insert(schema.invoice)
    .values({
      businessId: biz.id,
      clientId: client.id,
      currency,
      taxTreatment: "zero_rated",
    })
    .returning();

  const [invoiceLine] = await db
    .insert(schema.invoiceLine)
    .values({
      businessId: biz.id,
      invoiceId: invoice.id,
      position: 1,
      description: `${label} line`,
      totalMinor: 10_000,
    })
    .returning();

  const [invoiceSchedule] = await db
    .insert(schema.invoiceSchedule)
    .values({
      businessId: biz.id,
      clientId: client.id,
      name: `${label} Retainer`,
      currency,
      taxTreatment: "zero_rated",
      frequency: "monthly",
      interval: 1,
      anchorDay: 1,
      startDate: new Date(),
      nextRunAt: new Date(),
    })
    .returning();

  const [invoiceScheduleLine] = await db
    .insert(schema.invoiceScheduleLine)
    .values({
      businessId: biz.id,
      scheduleId: invoiceSchedule.id,
      position: 1,
      description: `${label} retainer line`,
      amountMinor: 120_000,
    })
    .returning();

  const [expense] = await db
    .insert(schema.expense)
    .values({
      businessId: biz.id,
      description: `${label} expense`,
      amountMinor: 500,
      currency,
      incurredAt: new Date(),
    })
    .returning();

  const [expenseTag] = await db
    .insert(schema.expenseTag)
    .values({ businessId: biz.id, name: `${slug} tag`, color: "teal" })
    .returning();

  await db
    .insert(schema.expenseTagLink)
    .values({ businessId: biz.id, expenseId: expense.id, tagId: expenseTag.id });

  const [activity] = await db
    .insert(schema.activity)
    .values({
      businessId: biz.id,
      clientId: client.id,
      userId: ownerId,
      type: "note",
      payload: { text: `${slug} note` },
    })
    .returning();

  return {
    businessId: biz.id,
    clientId: client.id,
    fingerprints: [
      biz.id,
      ownerId,
      memberId,
      `${ownerId}@t.dev`,
      `invitee-${slug}@t.dev`,
      `token-${slug}`,
      normalMember.id,
      role.id,
      permission.id,
      invitation.id,
      client.id,
      rate.id,
      project.id,
      task.id,
      timeEntry.id,
      invoice.id,
      invoiceLine.id,
      invoiceSchedule.id,
      invoiceScheduleLine.id,
      expense.id,
      expenseTag.id,
      `${slug} tag`,
      activity.id,
    ],
  };
}

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  ({ pglite, db } = await createTestDatabase());

  businessA = await seedFullBusiness("Alpha Studio", "alpha", "GBP");
  businessB = await seedFullBusiness("Beta Works", "beta", "EUR");
});

afterAll(async () => {
  await pglite.close();
});

describe("export completeness - structural", () => {
  it("exports every business-scoped table except the documented exemptions", () => {
    const exported = exportedTableNames();
    const exempt = new Set<string>(EXPORT_EXEMPT_TABLES);
    const required = businessScopedTableNames().filter(
      (name) => !exempt.has(name),
    );

    // Every business-scoped domain table must be represented in the export -
    // the anti-lock-in guarantee. Adding a new such table without wiring it
    // into EXPORT_ENTITIES fails here.
    for (const name of required) {
      expect(exported.has(name), `table "${name}" must be exported`).toBe(true);
    }

    // And the export must not claim a table that isn't business-scoped. The
    // business root is the one allowed extra: it is the settings row, keyed by
    // id rather than business_id.
    for (const name of exported) {
      if (name === "business") continue;
      expect(
        required.includes(name),
        `exported "${name}" is not a business-scoped table`,
      ).toBe(true);
    }

    // The business (settings) row is always exported.
    expect(exported.has("business")).toBe(true);
  });

  it("keeps the exemption list honest", () => {
    const scoped = new Set(businessScopedTableNames());
    const exported = exportedTableNames();
    for (const name of EXPORT_EXEMPT_TABLES) {
      // A stale exemption (table renamed/removed, or no longer business-scoped)
      // fails here rather than silently widening the export's blind spot.
      expect(
        scoped.has(name),
        `exempt table "${name}" must exist and carry business_id`,
      ).toBe(true);
      expect(
        exported.has(name),
        `exempt table "${name}" must not be exported`,
      ).toBe(false);
    }
  });

  it("guards against the schema reflection going stale", () => {
    expect(businessScopedTableNames().length).toBeGreaterThanOrEqual(10);
  });
});

describe("export completeness - data", () => {
  it("includes at least one row for every domain entity", async () => {
    const exp = await exportBusinessData(db, businessA.businessId);
    // Every collection has data: the seed put a row in each, so an empty
    // collection means the query is missing or mis-scoped.
    for (const entity of EXPORT_ENTITIES) {
      expect(
        exp.data[entity.key]?.length ?? 0,
        `collection "${entity.key}" should contain data`,
      ).toBeGreaterThan(0);
    }
    // The export's keys are exactly the registry's keys - no more, no less.
    expect(new Set(Object.keys(exp.data))).toEqual(
      new Set(EXPORT_ENTITIES.map((entity) => entity.key)),
    );
  });

  it("carries the documented format metadata for portability", async () => {
    const exp = await exportBusinessData(db, businessA.businessId, {
      exportedAt: new Date("2026-07-04T00:00:00Z"),
    });
    expect(exp.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(exp.kind).toBe(EXPORT_KIND);
    expect(exp.exportedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(exp.businessId).toBe(businessA.businessId);
    // `business` is the single settings row.
    expect(exp.data.business).toHaveLength(1);
    expect((exp.data.business[0] as { id: string }).id).toBe(
      businessA.businessId,
    );
    // Members are enriched with their identity so the file is re-importable.
    const [member] = exp.data.members as { email: string }[];
    expect(member.email).toContain("@t.dev");
    // The whole thing round-trips through JSON (dates become ISO strings).
    expect(() => JSON.parse(JSON.stringify(exp))).not.toThrow();
  });
});

describe("export scoping", () => {
  it("exports only the caller's business, never another business's data", async () => {
    const exp = await exportBusinessData(db, businessA.businessId);
    const json = JSON.stringify(exp);

    // Not a single one of business B's unique ids or strings may appear.
    for (const fingerprint of businessB.fingerprints) {
      expect(
        json.includes(fingerprint),
        `export must not leak business B's "${fingerprint}"`,
      ).toBe(false);
    }

    // Positive control: A's own identifiers are present, so the check above
    // isn't passing merely because the export is empty.
    expect(json).toContain(businessA.businessId);
    expect(json).toContain(businessA.clientId);
  });

  it("stamps every exported row with the caller's business", async () => {
    const exp = await exportBusinessData(db, businessA.businessId);
    for (const [key, rows] of Object.entries(exp.data)) {
      for (const row of rows as Record<string, unknown>[]) {
        // The business root is keyed by id; every other collection by
        // businessId. Either way it must be business A.
        const owner = key === "business" ? row.id : row.businessId;
        expect(owner, `a "${key}" row is not scoped to business A`).toBe(
          businessA.businessId,
        );
      }
    }
  });
});
